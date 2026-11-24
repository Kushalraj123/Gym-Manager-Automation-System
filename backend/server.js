/**
 * ============================================================================
 * GYM MANAGER AUTOMATION SYSTEM — BACKEND API & N8N WORKFLOW ENGINE SERVER
 * ============================================================================
 * Zero external runtime dependencies (runs on pure Node.js v18+ / v22+).
 *
 * Implements:
 *  - Workflow 1: New Member Registration (POST /api/workflows/1/register)
 *    Form Trigger -> Validate Input -> Normalize Phone -> Check Duplicate ->
 *    Calculate Expiry (with month-end clamping) -> Add Member to Google Sheets ->
 *    Send Welcome WhatsApp Message
 *
 *  - Workflow 2: Membership Expiry Reminder (POST /api/workflows/2/run-reminders)
 *    Schedule Trigger -> Read Members -> Calculate Remaining Days ->
 *    Filter Expiring Members (3 days & 0 days) -> Check Consent ->
 *    Check Reminder Logs (Idempotency) -> Send WhatsApp Template -> Save Reminder Log
 *
 *  - Workflow 3: Payment Processing
 *    A) Razorpay Webhook (POST /api/workflows/3/razorpay-webhook)
 *       Verifies HMAC-SHA256 signature on raw request body -> Checks Duplicate Reference ->
 *       Finds Member -> Updates Payment -> Extends Membership -> Saves Transaction ->
 *       Notifies Member via WhatsApp
 *    B) Manual Cash/UPI Payment Form (POST /api/workflows/3/manual-payment)
 *    C) Razorpay Payment Link Generator (POST /api/payments/create-link)
 *
 *  - Workflow 4: Daily Gym Report (POST /api/workflows/4/daily-report)
 *    Schedule Trigger -> Read Members -> Read Payments -> Calculate Statistics ->
 *    Generate Clean HTML Report -> Send Email to Owner
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  getTodayIST,
  getTimestampIST,
  normalizeIndianPhone,
  addMonthsClamped,
  resolveDurationMonths,
  resolvePlanPrice,
  calculateDaysDifference,
  generateSequentialId,
  verifyRazorpaySignature,
  createRazorpayTestSignature,
  calculateRenewalExpiryDate,
} = require('./workflowEngine');

const {
  SHEET_SCHEMAS,
  loadDatabase,
  saveDatabase,
  resetDatabase,
  SHEETS_CSV_DIR,
} = require('./sheetsDb');

const {
  connectMongoAtlas,
  disconnectMongoAtlas,
  syncLocalToMongoAtlas,
  pullFromMongoAtlas,
  getMongoStatus,
} = require('./mongoDb');

const PORT = process.env.PORT || 3000;
const DEFAULT_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'gym_rzp_whsec_9f8e7d6c5b4a3f2e1d0c';

// Ensure database is initialized on boot and auto-connect to MongoDB Atlas if configured
const initialDb = loadDatabase();
connectMongoAtlas()
  .then(async (res) => {
    if (res.ok) {
      console.log(`🍃 Connected to MongoDB Atlas (${res.status.uriMasked} -> ${res.status.dbName})`);
      const counts = res.status.collectionCounts || {};
      if (Number(counts.members || 0) > 0) {
        // Hydrate server state from MongoDB Atlas cloud collections on startup (ideal for Render/Railway/Cloud deploys)
        const pulled = await pullFromMongoAtlas(initialDb);
        if (pulled.ok && pulled.dbData) {
          saveDatabase(pulled.dbData);
          console.log(`☁️  Hydrated local state from MongoDB Atlas (${pulled.dbData.Members.length} members, ${pulled.dbData.Payments.length} payments)`);
          return;
        }
      }
      return syncLocalToMongoAtlas(initialDb);
    }
  })
  .catch(() => {});

function appendAuditLog(db, workflowName, status, summary, nodeTrace = []) {
  if (!Array.isArray(db.Execution_Audit_Logs)) {
    db.Execution_Audit_Logs = [];
  }
  const entry = {
    executionId: `EXEC-${Date.now()}-${Math.floor(Math.random() * 900 + 100)}`,
    timestamp: getTimestampIST(),
    workflow: workflowName,
    status,
    summary,
    nodeTrace,
  };
  db.Execution_Audit_Logs.unshift(entry);
  if (db.Execution_Audit_Logs.length > 100) {
    db.Execution_Audit_Logs = db.Execution_Audit_Logs.slice(0, 100);
  }
  return entry;
}

/**
 * ============================================================================
 * WORKFLOW 1: NEW MEMBER REGISTRATION
 * ============================================================================
 * Pipeline:
 * 1. Form Trigger
 * 2. Validate Input & Normalize Indian Phone
 * 3. Check Duplicate Phone in Sheet 1 (Members)
 * 4. Calculate Expiry Date (handling month-end clamping e.g. Jan 31 + 1M = Feb 28/29)
 * 5. Add Member to Google Sheets (Members + initial Payment row)
 * 6. Send Welcome WhatsApp Message (if WhatsApp_Consent === TRUE)
 */
function executeWorkflow1Registration(payload) {
  const db = loadDatabase();
  const settings = db.Gym_Settings[0] || {};
  const nodeTrace = [];

  // Node 1: Form Trigger
  nodeTrace.push({
    node: '1. Form / Webhook Trigger',
    type: 'n8n-nodes-base.webhook',
    status: 'SUCCESS',
    output: payload,
  });

  // Node 2: Validate Input & Normalize Phone
  const name = String(payload.name || payload.Name || '').trim();
  const email = String(payload.email || payload.Email || '').trim().toLowerCase();
  const rawPhone = payload.phone || payload.Phone || '';
  const plan = String(payload.plan || payload.Plan || 'Monthly').trim();
  const durationMonths = resolveDurationMonths(plan, payload.durationMonths || payload.duration);
  const joiningDate = String(payload.joiningDate || payload.Joining_Date || getTodayIST()).trim();
  const paymentStatus = String(payload.paymentStatus || payload.Payment_Status || 'Paid').trim();
  const paymentMethod = String(payload.paymentMethod || payload.Payment_Method || 'UPI').trim();
  const whatsappConsentRaw = payload.whatsappConsent ?? payload.WhatsApp_Consent ?? true;
  const whatsappConsent =
    whatsappConsentRaw === true ||
    String(whatsappConsentRaw).toUpperCase() === 'TRUE' ||
    String(whatsappConsentRaw).toLowerCase() === 'yes'
      ? 'TRUE'
      : 'FALSE';

  const errors = [];
  if (!name || name.length < 2) errors.push('Full Name is required (minimum 2 characters).');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Invalid email address format.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(joiningDate)) errors.push('Joining Date must be in YYYY-MM-DD format.');
  if (!['Paid', 'Pending'].includes(paymentStatus)) errors.push('Payment Status must be Paid or Pending.');

  const phoneResult = normalizeIndianPhone(rawPhone);
  if (!phoneResult.valid) {
    errors.push(phoneResult.error);
  }

  if (errors.length > 0) {
    nodeTrace.push({
      node: '2. Validate Input & Normalize Phone (Code Node)',
      type: 'n8n-nodes-base.code',
      status: 'ERROR',
      errors,
    });
    const audit = appendAuditLog(db, 'Workflow 1: Member Registration', 'REJECTED', errors.join(' | '), nodeTrace);
    saveDatabase(db);
    return {
      ok: false,
      statusCode: 400,
      error: errors.join(' '),
      errors,
      execution: audit,
    };
  }

  nodeTrace.push({
    node: '2. Validate Input & Normalize Phone (Code Node)',
    type: 'n8n-nodes-base.code',
    status: 'SUCCESS',
    output: {
      normalizedPhone: phoneResult.phoneE164,
      phone10: phoneResult.phone10,
      joiningDate,
      durationMonths,
    },
  });

  // Node 3: Check Duplicate Member by Phone Number
  const existingMember = db.Members.find((m) => String(m.Phone) === phoneResult.phoneE164);
  if (existingMember) {
    const dupMsg = `Duplicate member detected: Phone ${phoneResult.phoneE164} is already registered to ${existingMember.Name} (${existingMember.Member_ID}).`;
    nodeTrace.push({
      node: '3. Check Duplicate Phone (Google Sheets Lookup + IF Node)',
      type: 'n8n-nodes-base.if',
      status: 'DUPLICATE_BLOCKED',
      output: { existingMemberId: existingMember.Member_ID, existingName: existingMember.Name },
    });
    const audit = appendAuditLog(db, 'Workflow 1: Member Registration', 'DUPLICATE_BLOCKED', dupMsg, nodeTrace);
    saveDatabase(db);
    return {
      ok: false,
      statusCode: 409,
      error: dupMsg,
      existingMember,
      execution: audit,
    };
  }

  nodeTrace.push({
    node: '3. Check Duplicate Phone (Google Sheets Lookup + IF Node)',
    type: 'n8n-nodes-base.if',
    status: 'SUCCESS',
    output: { isDuplicate: false },
  });

  // Node 4: Calculate Expiry Date & Generate Member_ID
  const expiryDate = addMonthsClamped(joiningDate, durationMonths);
  const memberId = generateSequentialId('GYM', db.Members, 'Member_ID', 1001);
  const daysLeft = calculateDaysDifference(expiryDate, getTodayIST());
  const memberStatus =
    daysLeft < 0 ? 'Expired' : daysLeft === 0 ? 'Expiring Today' : daysLeft <= 3 ? 'Expiring Soon' : 'Active';

  nodeTrace.push({
    node: '4. Calculate Expiry & Member ID (Code Node)',
    type: 'n8n-nodes-base.code',
    status: 'SUCCESS',
    output: {
      Member_ID: memberId,
      Joining_Date: joiningDate,
      Duration_Months: durationMonths,
      Expiry_Date: expiryDate,
      Member_Status: memberStatus,
    },
  });

  // Node 5: Append Member to Google Sheets (Members tab) & initial Payment record
  const newMemberRow = {
    Member_ID: memberId,
    Name: name,
    Phone: phoneResult.phoneE164,
    Email: email || '',
    Plan: plan,
    Joining_Date: joiningDate,
    Expiry_Date: expiryDate,
    Payment_Status: paymentStatus,
    Payment_Method: paymentMethod,
    WhatsApp_Consent: whatsappConsent,
    Last_Reminder_Date: '',
    Member_Status: memberStatus,
  };
  db.Members.push(newMemberRow);

  const planAmount = Number(payload.amount) > 0 ? Number(payload.amount) : resolvePlanPrice(plan, durationMonths, settings);
  const paymentId = generateSequentialId('PAY', db.Payments, 'Payment_ID', 5001);
  const paymentRef =
    payload.paymentReference ||
    (paymentStatus === 'Paid'
      ? `${paymentMethod.toUpperCase()}-REG-${memberId}`
      : `PENDING-${memberId}`);

  const newPaymentRow = {
    Payment_ID: paymentId,
    Member_ID: memberId,
    Amount: planAmount,
    Payment_Method: paymentMethod,
    Payment_Status: paymentStatus,
    Payment_Date: joiningDate,
    Razorpay_Reference: paymentRef,
    Webhook_Processed: paymentStatus === 'Paid' ? 'TRUE' : 'FALSE',
  };
  db.Payments.push(newPaymentRow);

  nodeTrace.push({
    node: '5. Add Member to Google Sheets (Members & Payments)',
    type: 'n8n-nodes-base.googleSheets',
    status: 'SUCCESS',
    output: { memberRow: newMemberRow, paymentRow: newPaymentRow },
  });

  // Node 6: Send Welcome WhatsApp Message (Meta WhatsApp Cloud API)
  let whatsappMessageResult = null;
  if (whatsappConsent === 'TRUE') {
    const wamid = `wamid.HBgM${phoneResult.phoneE164}WELCOME${Date.now()}`;
    const welcomeText = `Welcome to ${settings.Gym_Name || 'our Gym'}, ${name}! 🏋️‍♂️ Your ${plan} membership (${memberId}) is active from ${joiningDate} until ${expiryDate}. Payment Status: ${paymentStatus} (₹${planAmount}). Let's crush your fitness goals!`;
    whatsappMessageResult = {
      sent: true,
      templateName: 'gym_welcome_member_v1',
      recipient: phoneResult.phoneE164,
      messageId: wamid,
      previewText: welcomeText,
    };
    nodeTrace.push({
      node: '6. Send Welcome WhatsApp Message (HTTP Request -> Meta Graph API)',
      type: 'n8n-nodes-base.httpRequest',
      status: 'SUCCESS',
      output: whatsappMessageResult,
    });
  } else {
    whatsappMessageResult = {
      sent: false,
      reason: 'Skipped because WhatsApp_Consent is FALSE',
    };
    nodeTrace.push({
      node: '6. Send Welcome WhatsApp Message (Skipped - No Consent)',
      type: 'n8n-nodes-base.if',
      status: 'SKIPPED',
      output: whatsappMessageResult,
    });
  }

  const summary = `Registered ${name} (${memberId}) | Phone: ${phoneResult.phoneE164} | Expiry: ${expiryDate} | Payment: ${paymentStatus} (₹${planAmount})`;
  const audit = appendAuditLog(db, 'Workflow 1: Member Registration', 'SUCCESS', summary, nodeTrace);
  saveDatabase(db);

  return {
    ok: true,
    statusCode: 201,
    member: newMemberRow,
    payment: newPaymentRow,
    whatsapp: whatsappMessageResult,
    execution: audit,
  };
}

/**
 * ============================================================================
 * WORKFLOW 2: AUTOMATED MEMBERSHIP EXPIRY REMINDERS
 * ============================================================================
 * Pipeline:
 * 1. Schedule Trigger (Every morning at 08:00 Asia/Kolkata)
 * 2. Read Members from Google Sheets (Sheet 1: Members)
 * 3. Calculate Remaining Days & Filter Expiring Members (daysRemaining === 3 or 0)
 * 4. Check WhatsApp Consent (WhatsApp_Consent === "TRUE")
 * 5. Check Reminder_Logs (Sheet 3) & Last_Reminder_Date to prevent duplicate reminders on the same day
 * 6. Send WhatsApp Template via Meta Cloud API
 * 7. Save Reminder Log (Sheet 3) & Update Member's Last_Reminder_Date (Sheet 1)
 */
function executeWorkflow2ExpiryReminders(options = {}) {
  const db = loadDatabase();
  const today = options.referenceDate || getTodayIST();
  const settings = db.Gym_Settings[0] || {};
  const nodeTrace = [];

  nodeTrace.push({
    node: '1. Schedule Trigger (08:00 IST Daily)',
    type: 'n8n-nodes-base.scheduleTrigger',
    status: 'SUCCESS',
    output: { referenceDate: today, timezone: 'Asia/Kolkata' },
  });

  nodeTrace.push({
    node: '2. Read Members & Reminder_Logs (Google Sheets)',
    type: 'n8n-nodes-base.googleSheets',
    status: 'SUCCESS',
    output: { totalMembersRead: db.Members.length, totalLogsRead: db.Reminder_Logs.length },
  });

  const sentReminders = [];
  const skippedMembers = [];

  for (const member of db.Members) {
    const daysRemaining = calculateDaysDifference(member.Expiry_Date, today);

    // Filter only 3 days or 0 days (expiring today)
    if (daysRemaining !== 3 && daysRemaining !== 0) {
      continue;
    }

    const reminderType = daysRemaining === 3 ? '3DAY_EXPIRY' : 'TODAY_EXPIRY';
    const templateName = daysRemaining === 3 ? 'gym_expiry_3day_reminder' : 'gym_expiry_today_reminder';

    // Check WhatsApp Consent
    if (String(member.WhatsApp_Consent).toUpperCase() !== 'TRUE') {
      skippedMembers.push({
        Member_ID: member.Member_ID,
        Name: member.Name,
        Reminder_Type: reminderType,
        reason: 'WhatsApp_Consent is FALSE',
      });
      continue;
    }

    // Check duplicate reminder on the same day in Reminder_Logs OR Last_Reminder_Date
    const alreadyLoggedToday = db.Reminder_Logs.some(
      (log) =>
        log.Member_ID === member.Member_ID &&
        log.Sent_Date === today &&
        log.Reminder_Type === reminderType
    );

    if (alreadyLoggedToday || member.Last_Reminder_Date === today) {
      skippedMembers.push({
        Member_ID: member.Member_ID,
        Name: member.Name,
        Reminder_Type: reminderType,
        reason: `Duplicate prevented: Reminder already sent on ${today}`,
      });
      continue;
    }

    // Compose exact WhatsApp template message requested in specifications
    const messageBody =
      daysRemaining === 3
        ? `Hello ${member.Name}, your gym membership expires in 3 days. Please renew your membership to continue enjoying our facilities. Thank you!`
        : `Hello ${member.Name}, your gym membership expires today. Please renew your plan to continue your fitness journey!`;

    const wamid = `wamid.HBgM${member.Phone}REM${Date.now()}${Math.floor(Math.random() * 100)}`;
    const reminderId = generateSequentialId('REM', db.Reminder_Logs, 'Reminder_ID', 9001);

    const logRow = {
      Reminder_ID: reminderId,
      Member_ID: member.Member_ID,
      Phone: member.Phone,
      Reminder_Type: reminderType,
      Sent_Date: today,
      Delivery_Status: `SENT (${wamid})`,
    };

    db.Reminder_Logs.push(logRow);
    member.Last_Reminder_Date = today;

    sentReminders.push({
      ...logRow,
      Name: member.Name,
      Expiry_Date: member.Expiry_Date,
      Template_Name: templateName,
      Message_Preview: messageBody,
    });
  }

  nodeTrace.push({
    node: '3-5. Calculate Days, Filter (3d & 0d), Check Consent & Deduplicate (Code Node)',
    type: 'n8n-nodes-base.code',
    status: 'SUCCESS',
    output: {
      qualifyingToSend: sentReminders.length,
      skippedCount: skippedMembers.length,
      skippedDetails: skippedMembers,
    },
  });

  nodeTrace.push({
    node: '6-7. Send WhatsApp Templates & Save Reminder_Logs (HTTP Request + Google Sheets)',
    type: 'n8n-nodes-base.googleSheets',
    status: 'SUCCESS',
    output: { sentReminders },
  });

  const summary = `Processed ${db.Members.length} members for ${today}: Sent ${sentReminders.length} WhatsApp reminder(s), Skipped ${skippedMembers.length} (consent/duplicate).`;
  const audit = appendAuditLog(db, 'Workflow 2: Expiry Reminders', 'SUCCESS', summary, nodeTrace);
  saveDatabase(db);

  return {
    ok: true,
    referenceDate: today,
    gymName: settings.Gym_Name,
    sentCount: sentReminders.length,
    skippedCount: skippedMembers.length,
    sentReminders,
    skippedMembers,
    execution: audit,
  };
}

/**
 * ============================================================================
 * WORKFLOW 3: PAYMENT PROCESSING (Razorpay Webhook & Manual Cash/UPI Form)
 * ============================================================================
 * Security Requirements:
 * - Never mark a payment as successful based only on a browser redirect or an unverified webhook.
 * - For Razorpay Webhooks: Verify HMAC-SHA256 signature using the raw request body and secret.
 * - Prevent duplicate payment processing using unique Razorpay_Reference (Idempotency).
 * - Extend membership expiry dates when a renewal payment succeeds.
 */
function executeWorkflow3PaymentProcessing({
  source, // 'RAZORPAY_WEBHOOK' or 'MANUAL_FORM'
  rawBodyString,
  signatureHeader,
  webhookSecret = DEFAULT_WEBHOOK_SECRET,
  parsedPayload,
}) {
  const db = loadDatabase();
  const today = getTodayIST();
  const settings = db.Gym_Settings[0] || {};
  const nodeTrace = [];

  nodeTrace.push({
    node: `1. ${source === 'RAZORPAY_WEBHOOK' ? 'Razorpay Webhook Trigger' : 'Manual Payment Form Trigger'}`,
    type: 'n8n-nodes-base.webhook',
    status: 'SUCCESS',
    output: { source, receivedAt: getTimestampIST() },
  });

  let memberId = '';
  let phone = '';
  let amountInRupees = 0;
  let paymentMethod = 'Razorpay';
  let paymentReference = '';
  let planName = '';
  let durationMonths = 1;

  // Node 2: Verify Payment Authenticity (HMAC-SHA256 for Razorpay Webhook)
  if (source === 'RAZORPAY_WEBHOOK') {
    const verification = verifyRazorpaySignature(rawBodyString, signatureHeader, webhookSecret);
    if (!verification.verified) {
      nodeTrace.push({
        node: '2. Verify Razorpay HMAC-SHA256 Signature (Code Node)',
        type: 'n8n-nodes-base.code',
        status: 'SECURITY_REJECTED',
        output: { verified: false, reason: verification.reason },
      });
      const audit = appendAuditLog(
        db,
        'Workflow 3: Payment Processing',
        'SECURITY_REJECTED',
        `Rejected unverified Razorpay webhook: ${verification.reason}`,
        nodeTrace
      );
      saveDatabase(db);
      return {
        ok: false,
        statusCode: 401,
        error: `Webhook signature verification failed: ${verification.reason}. Never trusting unverified payment payload.`,
        execution: audit,
      };
    }

    // Parse Razorpay event payload
    const eventType = parsedPayload.event || 'payment_link.paid';
    const paymentEntity =
      parsedPayload?.payload?.payment?.entity ||
      parsedPayload?.payload?.payment_link?.entity ||
      parsedPayload;

    const paymentStatusRaw = String(paymentEntity.status || 'captured').toLowerCase();
    if (!['captured', 'paid'].includes(paymentStatusRaw)) {
      return {
        ok: false,
        statusCode: 400,
        error: `Ignored non-captured Razorpay event (${eventType}, status=${paymentStatusRaw}).`,
      };
    }

    const notes = paymentEntity.notes || parsedPayload.notes || {};
    memberId = String(notes.member_id || notes.Member_ID || parsedPayload.member_id || '').trim();
    phone = String(notes.phone || paymentEntity.contact || '').trim();
    // Razorpay amounts are in paise (e.g., 150000 paise = ₹1500) unless explicitly marked
    const rawAmount = Number(paymentEntity.amount || 0);
    amountInRupees = rawAmount >= 10000 && !parsedPayload.amountInRupees ? Math.round(rawAmount / 100) : rawAmount;
    paymentMethod = 'Razorpay';
    paymentReference = String(paymentEntity.id || parsedPayload.razorpay_payment_id || '').trim();
    planName = String(notes.plan || '').trim();
    durationMonths = resolveDurationMonths(planName, notes.duration_months);

    nodeTrace.push({
      node: '2. Verify Razorpay HMAC-SHA256 Signature (Code Node)',
      type: 'n8n-nodes-base.code',
      status: 'SUCCESS',
      output: {
        signatureVerified: true,
        eventType,
        paymentReference,
        amountInRupees,
        memberId,
      },
    });
  } else {
    // Manual Cash / UPI Form submission by Gym Owner
    memberId = String(parsedPayload.memberId || parsedPayload.Member_ID || '').trim();
    phone = String(parsedPayload.phone || parsedPayload.Phone || '').trim();
    amountInRupees = Number(parsedPayload.amount || parsedPayload.Amount || 0);
    paymentMethod = String(parsedPayload.paymentMethod || parsedPayload.Payment_Method || 'Cash').trim();
    paymentReference = String(
      parsedPayload.paymentReference ||
        parsedPayload.Razorpay_Reference ||
        `${paymentMethod.toUpperCase()}-${Date.now()}`
    ).trim();
    planName = String(parsedPayload.plan || parsedPayload.Plan || '').trim();
    durationMonths = resolveDurationMonths(planName, parsedPayload.durationMonths);

    if (!['Cash', 'UPI', 'Razorpay', 'Card'].includes(paymentMethod)) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Invalid payment method. Must be Cash, UPI, Card, or Razorpay.',
      };
    }
    if (!paymentReference) {
      return {
        ok: false,
        statusCode: 400,
        error: 'Unique payment reference / receipt number is required.',
      };
    }

    nodeTrace.push({
      node: '2. Validate Manual Payment Input (Code Node)',
      type: 'n8n-nodes-base.code',
      status: 'SUCCESS',
      output: { memberId, paymentMethod, paymentReference, amountInRupees, durationMonths },
    });
  }

  // Node 3: Check Duplicate Payment Reference in Sheet 2 (Payments) — Idempotency Guard
  const duplicatePayment = db.Payments.find(
    (p) =>
      String(p.Razorpay_Reference).toLowerCase() === paymentReference.toLowerCase() &&
      String(p.Payment_Status) === 'Paid' &&
      String(p.Webhook_Processed).toUpperCase() === 'TRUE'
  );

  if (duplicatePayment) {
    const idempMsg = `Idempotent skip: Payment reference "${paymentReference}" was already processed under ${duplicatePayment.Payment_ID}. Membership expiry was NOT double-extended.`;
    nodeTrace.push({
      node: '3. Check Duplicate Payment Reference (Idempotency IF Node)',
      type: 'n8n-nodes-base.if',
      status: 'IDEMPOTENT_DUPLICATE_BLOCKED',
      output: { existingPaymentId: duplicatePayment.Payment_ID, Razorpay_Reference: paymentReference },
    });
    const audit = appendAuditLog(
      db,
      'Workflow 3: Payment Processing',
      'IDEMPOTENT_SKIP',
      idempMsg,
      nodeTrace
    );
    saveDatabase(db);
    return {
      ok: false,
      statusCode: 409,
      idempotentSkip: true,
      error: idempMsg,
      existingPayment: duplicatePayment,
      execution: audit,
    };
  }

  nodeTrace.push({
    node: '3. Check Duplicate Payment Reference (Idempotency IF Node)',
    type: 'n8n-nodes-base.if',
    status: 'SUCCESS',
    output: { isDuplicateReference: false, Razorpay_Reference: paymentReference },
  });

  // Node 4: Find Member in Sheet 1 (Members) by Member_ID or Phone
  let normalizedLookupPhone = '';
  if (phone) {
    const pRes = normalizeIndianPhone(phone);
    if (pRes.valid) normalizedLookupPhone = pRes.phoneE164;
  }

  const member = db.Members.find(
    (m) =>
      (memberId && m.Member_ID.toUpperCase() === memberId.toUpperCase()) ||
      (normalizedLookupPhone && String(m.Phone) === normalizedLookupPhone)
  );

  if (!member) {
    const notFoundMsg = `Member not found for Member_ID="${memberId}" or Phone="${phone}".`;
    nodeTrace.push({
      node: '4. Find Member in Google Sheets (Members)',
      type: 'n8n-nodes-base.googleSheets',
      status: 'ERROR',
      output: { error: notFoundMsg },
    });
    const audit = appendAuditLog(db, 'Workflow 3: Payment Processing', 'ERROR', notFoundMsg, nodeTrace);
    saveDatabase(db);
    return {
      ok: false,
      statusCode: 404,
      error: notFoundMsg,
      execution: audit,
    };
  }

  // Resolve duration and amount if not explicitly supplied
  const effectivePlan = planName || member.Plan || 'Monthly';
  const effectiveDuration = resolveDurationMonths(
    effectivePlan,
    parsedPayload.durationMonths || parsedPayload?.payload?.payment?.entity?.notes?.duration_months
  );
  const effectiveAmount =
    amountInRupees > 0 ? amountInRupees : resolvePlanPrice(effectivePlan, effectiveDuration, settings);

  // Node 5 & 6: Update Payment Status & Extend Membership Expiry Date
  // Note: If the member had a "Pending" initial registration payment and is settling it without renewal flag,
  // or if it's a renewal payment, we extend expiry appropriately.
  const isSettlingPendingOnly =
    parsedPayload.settlePendingOnly === true && member.Payment_Status === 'Pending';

  const previousExpiryDate = member.Expiry_Date;
  let newExpiryDate = previousExpiryDate;

  if (!isSettlingPendingOnly) {
    const renewalCalc = calculateRenewalExpiryDate(previousExpiryDate, today, effectiveDuration);
    newExpiryDate = renewalCalc.newExpiryDate;
  }

  member.Plan = effectivePlan;
  member.Expiry_Date = newExpiryDate;
  member.Payment_Status = 'Paid';
  member.Payment_Method = paymentMethod;

  // Node 7: Save Transaction History in Sheet 2 (Payments)
  // Check if there is an existing Pending row for this member that matches
  let paymentRow = db.Payments.find(
    (p) => p.Member_ID === member.Member_ID && p.Payment_Status === 'Pending'
  );

  if (paymentRow) {
    paymentRow.Amount = effectiveAmount;
    paymentRow.Payment_Method = paymentMethod;
    paymentRow.Payment_Status = 'Paid';
    paymentRow.Payment_Date = today;
    paymentRow.Razorpay_Reference = paymentReference;
    paymentRow.Webhook_Processed = 'TRUE';
  } else {
    const newPaymentId = generateSequentialId('PAY', db.Payments, 'Payment_ID', 5001);
    paymentRow = {
      Payment_ID: newPaymentId,
      Member_ID: member.Member_ID,
      Amount: effectiveAmount,
      Payment_Method: paymentMethod,
      Payment_Status: 'Paid',
      Payment_Date: today,
      Razorpay_Reference: paymentReference,
      Webhook_Processed: 'TRUE',
    };
    db.Payments.push(paymentRow);
  }

  nodeTrace.push({
    node: '5-7. Update Member Expiry & Record Payment Transaction (Google Sheets)',
    type: 'n8n-nodes-base.googleSheets',
    status: 'SUCCESS',
    output: {
      Member_ID: member.Member_ID,
      previousExpiryDate,
      newExpiryDate,
      paymentRow,
    },
  });

  // Node 8: Notify Member via WhatsApp Business Cloud API
  let whatsappConfirmation = null;
  if (String(member.WhatsApp_Consent).toUpperCase() === 'TRUE') {
    const wamid = `wamid.HBgM${member.Phone}PAY${Date.now()}`;
    const msg = `Hello ${member.Name}, we have received your payment of ₹${effectiveAmount} via ${paymentMethod} (Ref: ${paymentReference}). Your gym membership (${member.Member_ID}) is now active until ${newExpiryDate}. Thank you!`;
    whatsappConfirmation = {
      sent: true,
      templateName: 'gym_payment_receipt_v1',
      recipient: member.Phone,
      messageId: wamid,
      previewText: msg,
    };
  } else {
    whatsappConfirmation = {
      sent: false,
      reason: 'WhatsApp_Consent is FALSE',
    };
  }

  nodeTrace.push({
    node: '8. Notify Member on WhatsApp (HTTP Request -> Meta Graph API)',
    type: 'n8n-nodes-base.httpRequest',
    status: 'SUCCESS',
    output: whatsappConfirmation,
  });

  const summary = `Payment ₹${effectiveAmount} (${paymentMethod} | Ref: ${paymentReference}) processed for ${member.Name} (${member.Member_ID}). Expiry extended: ${previousExpiryDate} -> ${newExpiryDate}.`;
  const audit = appendAuditLog(db, 'Workflow 3: Payment Processing', 'SUCCESS', summary, nodeTrace);
  saveDatabase(db);

  return {
    ok: true,
    statusCode: 200,
    member,
    previousExpiryDate,
    newExpiryDate,
    payment: paymentRow,
    whatsapp: whatsappConfirmation,
    execution: audit,
  };
}

/**
 * ============================================================================
 * WORKFLOW 4: DAILY GYM REPORT
 * ============================================================================
 * Pipeline:
 * 1. Schedule Trigger (Every morning at 08:30 Asia/Kolkata)
 * 2. Read Members (Sheet 1)
 * 3. Read Payments (Sheet 2)
 * 4. Calculate 8 Core Gym KPIs
 * 5. Generate Executive HTML Email Report
 * 6. Send Email to Gym Owner via Gmail Node
 */
function executeWorkflow4DailyReport(options = {}) {
  const db = loadDatabase();
  const today = options.referenceDate || getTodayIST();
  const settings = db.Gym_Settings[0] || {};
  const nodeTrace = [];

  const members = db.Members || [];
  const payments = db.Payments || [];

  let totalRegistered = members.length;
  let currentlyActive = 0;
  let expiredMemberships = 0;
  let expiringToday = 0;
  let expiringIn3Days = 0;
  let pendingPaymentsCount = 0;

  const expiringTodayList = [];
  const expiringIn3DaysList = [];

  for (const m of members) {
    const diff = calculateDaysDifference(m.Expiry_Date, today);
    if (diff >= 0) {
      currentlyActive++;
    } else {
      expiredMemberships++;
    }
    if (diff === 0) {
      expiringToday++;
      expiringTodayList.push(m);
    }
    if (diff === 3) {
      expiringIn3Days++;
      expiringIn3DaysList.push(m);
    }
    if (String(m.Payment_Status) === 'Pending') {
      pendingPaymentsCount++;
    }
  }

  const paymentsReceivedTodayList = payments.filter(
    (p) => p.Payment_Date === today && String(p.Payment_Status) === 'Paid'
  );
  const paymentsReceivedToday = paymentsReceivedTodayList.length;
  const totalRevenueToday = paymentsReceivedTodayList.reduce(
    (sum, p) => sum + (Number(p.Amount) || 0),
    0
  );
  const totalAllTimeRevenue = payments
    .filter((p) => String(p.Payment_Status) === 'Paid')
    .reduce((sum, p) => sum + (Number(p.Amount) || 0), 0);

  const stats = {
    reportDate: today,
    gymName: settings.Gym_Name || 'IronFit Pro Fitness Studio',
    ownerEmail: settings.Owner_Email || 'owner@ironfitgym.in',
    totalRegisteredMembers: totalRegistered,
    currentlyActiveMembers: currentlyActive,
    expiredMemberships,
    membershipsExpiringToday: expiringToday,
    membershipsExpiringIn3Days: expiringIn3Days,
    pendingPayments: pendingPaymentsCount,
    paymentsReceivedToday,
    totalRevenueCollectedToday: totalRevenueToday,
    totalAllTimeRevenue,
  };

  // Generate clean, professional HTML email report
  const htmlReport = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Daily Gym Business Report — ${stats.gymName}</title>
</head>
<body style="margin:0;padding:24px;background-color:#0f172a;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f8fafc;">
  <div style="max-width:640px;margin:0 auto;background:#1e293b;border-radius:12px;overflow:hidden;border:1px solid #334155;">
    <div style="background:linear-gradient(135deg,#059669,#0d9488);padding:24px 28px;">
      <p style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:#a7f3d0;font-weight:700;">AUTOMATED DAILY GYM BRIEFING</p>
      <h1 style="margin:6px 0 4px;font-size:22px;color:#ffffff;">${stats.gymName}</h1>
      <p style="margin:0;font-size:13px;color:#d1fae5;">Report Date: <strong>${stats.reportDate}</strong> (Asia/Kolkata IST)</p>
    </div>

    <div style="padding:24px 28px;">
      <h2 style="margin:0 0 14px;font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">1. Membership Overview</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:12px;background:#0f172a;border:1px solid #334155;border-radius:6px;width:33%;">
            <div style="font-size:12px;color:#94a3b8;">Total Registered</div>
            <div style="font-size:24px;font-weight:700;color:#f8fafc;margin-top:4px;">${stats.totalRegisteredMembers}</div>
          </td>
          <td style="padding:12px;background:#0f172a;border:1px solid #334155;border-radius:6px;width:33%;">
            <div style="font-size:12px;color:#94a3b8;">Currently Active</div>
            <div style="font-size:24px;font-weight:700;color:#34d399;margin-top:4px;">${stats.currentlyActiveMembers}</div>
          </td>
          <td style="padding:12px;background:#0f172a;border:1px solid #334155;border-radius:6px;width:33%;">
            <div style="font-size:12px;color:#94a3b8;">Expired Members</div>
            <div style="font-size:24px;font-weight:700;color:#f87171;margin-top:4px;">${stats.expiredMemberships}</div>
          </td>
        </tr>
      </table>

      <h2 style="margin:0 0 14px;font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">2. Renewal Pipeline & Expiry Alerts</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        <tr>
          <td style="padding:12px;background:#0f172a;border:1px solid #334155;width:50%;">
            <div style="font-size:12px;color:#fbbf24;">Expiring Today (${stats.reportDate})</div>
            <div style="font-size:22px;font-weight:700;color:#fbbf24;margin-top:4px;">${stats.membershipsExpiringToday}</div>
          </td>
          <td style="padding:12px;background:#0f172a;border:1px solid #334155;width:50%;">
            <div style="font-size:12px;color:#38bdf8;">Expiring in 3 Days</div>
            <div style="font-size:22px;font-weight:700;color:#38bdf8;margin-top:4px;">${stats.membershipsExpiringIn3Days}</div>
          </td>
        </tr>
      </table>

      <h2 style="margin:0 0 14px;font-size:15px;color:#94a3b8;text-transform:uppercase;letter-spacing:0.8px;">3. Revenue & Collections (${stats.reportDate})</h2>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
        <tr>
          <td style="padding:14px;background:#0f172a;border:1px solid #334155;width:33%;">
            <div style="font-size:12px;color:#94a3b8;">Payments Today</div>
            <div style="font-size:22px;font-weight:700;color:#f8fafc;margin-top:4px;">${stats.paymentsReceivedToday}</div>
          </td>
          <td style="padding:14px;background:#0f172a;border:1px solid #334155;width:33%;">
            <div style="font-size:12px;color:#94a3b8;">Revenue Today</div>
            <div style="font-size:22px;font-weight:700;color:#34d399;margin-top:4px;">₹${stats.totalRevenueCollectedToday.toLocaleString('en-IN')}</div>
          </td>
          <td style="padding:14px;background:#0f172a;border:1px solid #334155;width:33%;">
            <div style="font-size:12px;color:#94a3b8;">Pending Payments</div>
            <div style="font-size:22px;font-weight:700;color:#fb923c;margin-top:4px;">${stats.pendingPayments}</div>
          </td>
        </tr>
      </table>

      <div style="padding:12px 16px;background:#0f172a;border-left:4px solid #10b981;border-radius:4px;font-size:12px;color:#cbd5e1;">
        Sent automatically by <strong>n8n Workflow 4 (Daily Gym Report)</strong> • Sent to: ${stats.ownerEmail}
      </div>
    </div>
  </div>
</body>
</html>`;

  nodeTrace.push({
    node: '1-3. Schedule Trigger + Read Members & Payments (Google Sheets)',
    type: 'n8n-nodes-base.googleSheets',
    status: 'SUCCESS',
    output: { membersCount: members.length, paymentsCount: payments.length },
  });

  nodeTrace.push({
    node: '4-5. Calculate Statistics & Generate HTML Report (Code Node)',
    type: 'n8n-nodes-base.code',
    status: 'SUCCESS',
    output: stats,
  });

  nodeTrace.push({
    node: '6. Send Daily Report Email to Gym Owner (Gmail Node)',
    type: 'n8n-nodes-base.gmail',
    status: 'SUCCESS',
    output: {
      to: stats.ownerEmail,
      subject: `[${stats.gymName}] Daily Business Summary — ${stats.reportDate} | Revenue Today: ₹${stats.totalRevenueCollectedToday}`,
    },
  });

  if (!options.silentAudit) {
    const summary = `Generated Daily Report for ${today} -> Sent to ${stats.ownerEmail} | Active: ${currentlyActive}/${totalRegistered} | Revenue Today: ₹${totalRevenueToday}`;
    appendAuditLog(db, 'Workflow 4: Daily Gym Report', 'SUCCESS', summary, nodeTrace);
    saveDatabase(db);
  }

  return {
    ok: true,
    stats,
    expiringTodayList,
    expiringIn3DaysList,
    paymentsReceivedTodayList,
    htmlReport,
    nodeTrace,
  };
}

/**
 * Generates a Razorpay Payment Link + pre-signed Webhook Test Payload
 * so the user or gym owner can test end-to-end cryptographic webhook verification.
 */
function generateRazorpayPaymentLink({ memberId, plan, durationMonths, amount }) {
  const db = loadDatabase();
  const settings = db.Gym_Settings[0] || {};
  const member = db.Members.find((m) => m.Member_ID === memberId);
  if (!member) {
    return { ok: false, statusCode: 404, error: `Member ${memberId} not found.` };
  }

  const effectivePlan = plan || member.Plan || 'Monthly';
  const effectiveDuration = resolveDurationMonths(effectivePlan, durationMonths);
  const effectiveAmount =
    Number(amount) > 0 ? Number(amount) : resolvePlanPrice(effectivePlan, effectiveDuration, settings);

  const shortId = crypto.randomBytes(4).toString('hex');
  const paymentLinkId = `plink_${shortId}`;
  const simulatedPaymentId = `pay_Rzp${Date.now().toString().slice(-7)}${shortId.slice(0, 3)}`;

  const webhookPayloadObj = {
    entity: 'event',
    account_id: 'acc_GymIronFit01',
    event: 'payment_link.paid',
    contains: ['payment', 'payment_link'],
    payload: {
      payment: {
        entity: {
          id: simulatedPaymentId,
          entity: 'payment',
          amount: effectiveAmount * 100, // Razorpay stores amount in paise
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          email: member.Email || 'member@example.in',
          contact: `+${member.Phone}`,
          notes: {
            member_id: member.Member_ID,
            member_name: member.Name,
            phone: member.Phone,
            plan: effectivePlan,
            duration_months: String(effectiveDuration),
          },
        },
      },
    },
    created_at: Math.floor(Date.now() / 1000),
  };

  const rawBodyString = JSON.stringify(webhookPayloadObj);
  const validSignature = createRazorpayTestSignature(rawBodyString, DEFAULT_WEBHOOK_SECRET);

  return {
    ok: true,
    paymentLink: {
      id: paymentLinkId,
      short_url: `https://rzp.io/i/${shortId}`,
      amount: effectiveAmount,
      currency: 'INR',
      memberId: member.Member_ID,
      memberName: member.Name,
      plan: effectivePlan,
      durationMonths: effectiveDuration,
    },
    webhookSimulator: {
      paymentReference: simulatedPaymentId,
      rawBodyString,
      parsedPayload: webhookPayloadObj,
      validHmacSha256Signature: validSignature,
      webhookSecretUsed: DEFAULT_WEBHOOK_SECRET,
    },
  };
}

/**
 * ============================================================================
 * HTTP SERVER & STATIC FRONTEND ROUTER
 * ============================================================================
 */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-razorpay-signature',
  });
  res.end(JSON.stringify(data, null, 2));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-razorpay-signature',
      });
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    try {
      // 1. GET full database state + live KPIs
      if (req.method === 'GET' && pathname === '/api/state') {
        const db = loadDatabase();
        const report = executeWorkflow4DailyReport({ silentAudit: true });
        return sendJSON(res, 200, {
          ok: true,
          todayIST: getTodayIST(),
          schemas: SHEET_SCHEMAS,
          sheets: {
            Members: db.Members,
            Payments: db.Payments,
            Reminder_Logs: db.Reminder_Logs,
            Gym_Settings: db.Gym_Settings,
          },
          trainers: db.Trainers || [],
          memberProfiles: db.Member_Profiles || {},
          auditLogs: db.Execution_Audit_Logs || [],
          dailyReport: report,
          mongoStatus: getMongoStatus(),
        });
      }

      // 1A. MongoDB Atlas Cloud Connection & Two-Way Sync Endpoints
      if (req.method === 'GET' && pathname === '/api/mongodb/status') {
        return sendJSON(res, 200, { ok: true, mongoStatus: getMongoStatus() });
      }

      if (req.method === 'POST' && pathname === '/api/mongodb/connect') {
        const raw = await readRawBody(req);
        const payload = JSON.parse(raw || '{}');
        const uri = String(payload.uri || '').trim();
        const dbName = String(payload.dbName || 'gym_manager_saas').trim();
        const connRes = await connectMongoAtlas(uri, dbName);
        if (!connRes.ok) {
          return sendJSON(res, 400, {
            ok: false,
            error: connRes.error || connRes.status?.lastError || 'Failed to connect to MongoDB Atlas.',
            mongoStatus: connRes.status,
          });
        }
        const db = loadDatabase();
        const syncRes = await syncLocalToMongoAtlas(db);
        appendAuditLog(
          db,
          'MongoDB Atlas Cloud Sync',
          'SUCCESS',
          `Connected & synced all 7 collections to MongoDB Atlas database "${dbName}" (${connRes.status.uriMasked})`
        );
        saveDatabase(db);
        return sendJSON(res, 200, {
          ok: true,
          message: `Connected to MongoDB Atlas (${dbName}) & synced all collections.`,
          mongoStatus: syncRes.status || connRes.status,
        });
      }

      if (req.method === 'POST' && pathname === '/api/mongodb/sync') {
        const raw = await readRawBody(req);
        const payload = JSON.parse(raw || '{}');
        const direction = String(payload.direction || 'PUSH').toUpperCase();
        const db = loadDatabase();

        if (direction === 'PULL') {
          const pullRes = await pullFromMongoAtlas(db);
          if (!pullRes.ok) {
            return sendJSON(res, 400, { ok: false, error: pullRes.error, mongoStatus: getMongoStatus() });
          }
          appendAuditLog(
            pullRes.dbData,
            'MongoDB Atlas Pull',
            'SUCCESS',
            'Pulled latest cloud collections from MongoDB Atlas into local state & Google Sheets CSVs.'
          );
          saveDatabase(pullRes.dbData);
          return sendJSON(res, 200, {
            ok: true,
            message: 'Pulled latest documents from MongoDB Atlas into local state & CSVs.',
            mongoStatus: pullRes.status,
          });
        }

        const pushRes = await syncLocalToMongoAtlas(db);
        if (!pushRes.ok) {
          return sendJSON(res, 400, {
            ok: false,
            error: pushRes.error || pushRes.reason || 'Failed to push to MongoDB Atlas.',
            mongoStatus: getMongoStatus(),
          });
        }
        appendAuditLog(
          db,
          'MongoDB Atlas Push',
          'SUCCESS',
          'Pushed all members, payments, reminders, trainers & profiles to MongoDB Atlas.'
        );
        saveDatabase(db);
        return sendJSON(res, 200, {
          ok: true,
          message: 'Pushed all collections to MongoDB Atlas.',
          mongoStatus: pushRes.status,
        });
      }

      if (req.method === 'POST' && pathname === '/api/mongodb/disconnect') {
        const discRes = await disconnectMongoAtlas();
        return sendJSON(res, 200, {
          ok: true,
          message: 'Disconnected from MongoDB Atlas.',
          mongoStatus: discRes.status,
        });
      }

      // 1B. POST Role-Based Login (Owner, Trainer, or Member)
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        const raw = await readRawBody(req);
        const payload = JSON.parse(raw || '{}');
        const role = String(payload.role || '').toUpperCase();
        const identifier = String(payload.identifier || '').trim();
        const pin = String(payload.pin || '').trim();
        const db = loadDatabase();

        if (role === 'OWNER') {
          if (pin && pin !== 'admin123' && pin !== '1234') {
            return sendJSON(res, 401, { ok: false, error: 'Invalid Owner PIN (Default: 1234 or admin123).' });
          }
          return sendJSON(res, 200, {
            ok: true,
            session: {
              role: 'OWNER',
              id: 'OWNER-1',
              name: 'Gym Owner / Admin',
              email: (db.Gym_Settings[0] && db.Gym_Settings[0].Owner_Email) || 'owner@ironfitgym.in',
            },
          });
        }

        if (role === 'TRAINER') {
          const normPhone = normalizeIndianPhone(identifier);
          const trainer = (db.Trainers || []).find(
            (t) =>
              t.Trainer_ID.toUpperCase() === identifier.toUpperCase() ||
              t.Email.toLowerCase() === identifier.toLowerCase() ||
              (normPhone.valid && t.Phone === normPhone.phoneE164)
          );
          if (!trainer) {
            return sendJSON(res, 404, {
              ok: false,
              error: `Trainer not found for ID/Phone "${identifier}". Try TRN-201 or TRN-202.`,
            });
          }
          if (pin && trainer.Pin && pin !== trainer.Pin) {
            return sendJSON(res, 401, { ok: false, error: 'Invalid Trainer PIN (Default: 1234).' });
          }
          return sendJSON(res, 200, {
            ok: true,
            session: {
              role: 'TRAINER',
              id: trainer.Trainer_ID,
              name: trainer.Name,
              specialty: trainer.Specialty,
              shift: trainer.Shift,
              phone: trainer.Phone,
              email: trainer.Email,
            },
          });
        }

        if (role === 'MEMBER') {
          const normPhone = normalizeIndianPhone(identifier);
          const member = (db.Members || []).find(
            (m) =>
              m.Member_ID.toUpperCase() === identifier.toUpperCase() ||
              (m.Email && m.Email.toLowerCase() === identifier.toLowerCase()) ||
              (normPhone.valid && String(m.Phone) === normPhone.phoneE164) ||
              String(m.Phone).endsWith(identifier.replace(/\D/g, ''))
          );
          if (!member) {
            return sendJSON(res, 404, {
              ok: false,
              error: `Member not found for Member ID or Phone "${identifier}". Try GYM-1001 or 9876543210.`,
            });
          }
          const last4 = String(member.Phone).slice(-4);
          if (pin && pin !== '1234' && pin !== last4) {
            return sendJSON(res, 401, {
              ok: false,
              error: `Invalid Member PIN. Use 1234 or the last 4 digits of your phone (${last4}).`,
            });
          }
          return sendJSON(res, 200, {
            ok: true,
            session: {
              role: 'MEMBER',
              id: member.Member_ID,
              name: member.Name,
              phone: member.Phone,
              email: member.Email,
              plan: member.Plan,
            },
          });
        }

        return sendJSON(res, 400, { ok: false, error: 'Invalid login role. Choose OWNER, TRAINER, or MEMBER.' });
      }

      // 1C. POST Trainer Update Member Workout Plan / Diet / Attendance Check-In
      if (req.method === 'POST' && pathname === '/api/trainer/update-member-plan') {
        const raw = await readRawBody(req);
        const payload = JSON.parse(raw || '{}');
        const memberId = String(payload.memberId || '').trim();
        const db = loadDatabase();
        const member = db.Members.find((m) => m.Member_ID === memberId);
        if (!member) {
          return sendJSON(res, 404, { ok: false, error: `Member ${memberId} not found.` });
        }
        if (!db.Member_Profiles) db.Member_Profiles = {};
        const currentProfile = db.Member_Profiles[memberId] || {
          Assigned_Trainer_ID: 'TRN-201',
          Workout_Plan: 'General Fitness & Strength Routine',
          Diet_Notes: 'Balanced High-Protein Diet',
          Attendance_Count: 1,
          Last_CheckIn: getTodayIST(),
        };

        if (payload.assignedTrainerId) currentProfile.Assigned_Trainer_ID = payload.assignedTrainerId;
        if (payload.workoutPlan !== undefined) currentProfile.Workout_Plan = payload.workoutPlan;
        if (payload.dietNotes !== undefined) currentProfile.Diet_Notes = payload.dietNotes;
        if (payload.markAttendance) {
          currentProfile.Attendance_Count = Number(currentProfile.Attendance_Count || 0) + 1;
          currentProfile.Last_CheckIn = getTodayIST();
        }

        db.Member_Profiles[memberId] = currentProfile;
        appendAuditLog(
          db,
          'Trainer Portal Update',
          'SUCCESS',
          `Updated workout/diet/attendance for ${member.Name} (${memberId})`
        );
        saveDatabase(db);
        return sendJSON(res, 200, { ok: true, memberId, profile: currentProfile });
      }

      // 2. POST Workflow 1: Member Registration
      if (req.method === 'POST' && pathname === '/api/workflows/1/register') {
        const raw = await readRawBody(req);
        const payload = JSON.parse(raw || '{}');
        const result = executeWorkflow1Registration(payload);
        return sendJSON(res, result.statusCode || 200, result);
      }

      // 3. POST Workflow 2: Automated Membership Expiry Reminders
      if (req.method === 'POST' && pathname === '/api/workflows/2/run-reminders') {
        const raw = await readRawBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const result = executeWorkflow2ExpiryReminders(payload);
        return sendJSON(res, 200, result);
      }

      // 4. POST Workflow 3A: Razorpay Webhook (Cryptographic HMAC-SHA256 Verification)
      if (req.method === 'POST' && pathname === '/api/workflows/3/razorpay-webhook') {
        const rawBodyString = await readRawBody(req);
        const signatureHeader = req.headers['x-razorpay-signature'] || '';
        let parsedPayload = {};
        try {
          parsedPayload = JSON.parse(rawBodyString || '{}');
        } catch (e) {
          return sendJSON(res, 400, { ok: false, error: 'Invalid JSON body in webhook.' });
        }
        const result = executeWorkflow3PaymentProcessing({
          source: 'RAZORPAY_WEBHOOK',
          rawBodyString,
          signatureHeader,
          webhookSecret: DEFAULT_WEBHOOK_SECRET,
          parsedPayload,
        });
        return sendJSON(res, result.statusCode || 200, result);
      }

      // 5. POST Workflow 3B: Manual Cash / UPI Payment Update
      if (req.method === 'POST' && pathname === '/api/workflows/3/manual-payment') {
        const rawBodyString = await readRawBody(req);
        const parsedPayload = JSON.parse(rawBodyString || '{}');
        const result = executeWorkflow3PaymentProcessing({
          source: 'MANUAL_FORM',
          rawBodyString,
          parsedPayload,
        });
        return sendJSON(res, result.statusCode || 200, result);
      }

      // 6. POST Generate Razorpay Payment Link & Signed Webhook Payload
      if (req.method === 'POST' && pathname === '/api/payments/create-link') {
        const raw = await readRawBody(req);
        const payload = JSON.parse(raw || '{}');
        const result = generateRazorpayPaymentLink(payload);
        return sendJSON(res, result.statusCode || 200, result);
      }

      // 7. POST Workflow 4: Daily Gym Report
      if (req.method === 'POST' && pathname === '/api/workflows/4/daily-report') {
        const raw = await readRawBody(req);
        const payload = raw ? JSON.parse(raw) : {};
        const result = executeWorkflow4DailyReport({ ...payload, silentAudit: false });
        return sendJSON(res, 200, result);
      }

      // 8. POST Update Gym_Settings (Sheet 4)
      if (req.method === 'POST' && pathname === '/api/settings') {
        const raw = await readRawBody(req);
        const payload = JSON.parse(raw || '{}');
        const db = loadDatabase();
        const current = db.Gym_Settings[0] || {};
        db.Gym_Settings[0] = {
          Gym_Name: payload.Gym_Name || current.Gym_Name || 'IronFit Pro Fitness Studio',
          Owner_Email: payload.Owner_Email || current.Owner_Email || 'owner@ironfitgym.in',
          WhatsApp_Number: payload.WhatsApp_Number || current.WhatsApp_Number || '919820011223',
          Monthly_Plan_Price: Number(payload.Monthly_Plan_Price || current.Monthly_Plan_Price || 2000),
          Quarterly_Plan_Price: Number(payload.Quarterly_Plan_Price || current.Quarterly_Plan_Price || 4000),
          Half_Yearly_Plan_Price: Number(payload.Half_Yearly_Plan_Price || current.Half_Yearly_Plan_Price || 6000),
          Yearly_Plan_Price: Number(payload.Yearly_Plan_Price || current.Yearly_Plan_Price || 9000),
          Reminder_Time: payload.Reminder_Time || current.Reminder_Time || '08:00',
        };
        appendAuditLog(
          db,
          'Gym_Settings Update',
          'SUCCESS',
          `Updated Gym_Settings for ${db.Gym_Settings[0].Gym_Name}`
        );
        saveDatabase(db);
        return sendJSON(res, 200, { ok: true, settings: db.Gym_Settings[0] });
      }

      // 9. POST Reset Demo Database
      if (req.method === 'POST' && pathname === '/api/reset-demo') {
        const seeded = resetDatabase();
        return sendJSON(res, 200, {
          ok: true,
          message: 'Database reset to clean initial Indian gym dataset.',
          sheets: seeded,
        });
      }

      // 10. Download CSV for any of the 4 Google Sheets tabs
      if (req.method === 'GET' && pathname.startsWith('/api/sheets/csv/')) {
        const sheetName = pathname.replace('/api/sheets/csv/', '').replace('.csv', '');
        if (!SHEET_SCHEMAS[sheetName]) {
          return sendJSON(res, 404, { ok: false, error: `Unknown sheet: ${sheetName}` });
        }
        const csvPath = path.join(SHEETS_CSV_DIR, `${sheetName}.csv`);
        const content = fs.readFileSync(csvPath, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${sheetName}.csv"`,
        });
        return res.end(content);
      }

      // 11. Download importable n8n Workflow JSON files
      if (req.method === 'GET' && pathname.startsWith('/api/n8n-workflows/')) {
        const fileName = path.basename(pathname);
        const wfPath = path.join(__dirname, '..', 'n8n-workflows', fileName);
        if (fs.existsSync(wfPath)) {
          const content = fs.readFileSync(wfPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${fileName}"`,
          });
          return res.end(content);
        }
        return sendJSON(res, 404, { ok: false, error: 'Workflow JSON not found' });
      }

      // 12. Serve Static Frontend Files from /frontend
      const frontendDir = path.join(__dirname, '..', 'frontend');
      let filePath = pathname === '/' ? path.join(frontendDir, 'index.html') : path.join(frontendDir, pathname);

      // Prevent directory traversal
      if (!filePath.startsWith(frontendDir)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mimeType });
        return fs.createReadStream(filePath).pipe(res);
      }

      // Fallback to index.html for SPA navigation
      const indexHtml = path.join(frontendDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return fs.createReadStream(indexHtml).pipe(res);
      }

      res.writeHead(404);
      res.end('Not Found');
    } catch (err) {
      return sendJSON(res, 500, { ok: false, error: err.message });
    }
  });
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, () => {
    console.log(`====================================================================`);
    console.log(`🏋️  GYM MANAGER AUTOMATION SYSTEM — FULL-STACK SERVER & N8N ENGINE`);
    console.log(`====================================================================`);
    console.log(`🚀 Web Dashboard & Simulator : http://localhost:${PORT}`);
    console.log(`📊 Google Sheets CSV Exports : http://localhost:${PORT}/api/sheets/csv/Members.csv`);
    console.log(`🕒 Active Timezone           : Asia/Kolkata (Today: ${getTodayIST()})`);
    console.log(`====================================================================`);
  });
}

module.exports = {
  createServer,
  executeWorkflow1Registration,
  executeWorkflow2ExpiryReminders,
  executeWorkflow3PaymentProcessing,
  executeWorkflow4DailyReport,
  generateRazorpayPaymentLink,
  DEFAULT_WEBHOOK_SECRET,
};
