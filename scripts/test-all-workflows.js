/**
 * ============================================================================
 * END-TO-END AUTOMATED VERIFICATION SUITE (ALL 4 WORKFLOWS + EDGE CASES)
 * ============================================================================
 * Tests:
 *  1. Google Sheets 4-tab seeding & CSV export generation
 *  2. Indian phone number normalization (+91, 0-prefix, 10-digit, invalid rejection)
 *  3. Month-end date clamping (Jan 31 + 1 month = Feb 28 / Feb 29 leap year)
 *  4. Workflow 1: Member Registration & Duplicate Phone Prevention (409 Conflict)
 *  5. Workflow 2: Automated Expiry Reminders (3-day & Today), Consent Check & Same-Day Idempotency
 *  6. Workflow 3: Razorpay Webhook HMAC-SHA256 verification, Tampered Signature Rejection (401),
 *                 Duplicate Payment Reference Idempotency (409), and Membership Expiry Extension
 *  7. Workflow 4: Daily Gym Report KPI calculations & HTML report generation
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  getTodayIST,
  normalizeIndianPhone,
  addMonthsClamped,
} = require('../backend/workflowEngine');

const {
  resetDatabase,
  SHEETS_CSV_DIR,
} = require('../backend/sheetsDb');

const {
  executeWorkflow1Registration,
  executeWorkflow2ExpiryReminders,
  executeWorkflow3PaymentProcessing,
  executeWorkflow4DailyReport,
  generateRazorpayPaymentLink,
} = require('../backend/server');

function runAllTests() {
  console.log('====================================================================');
  console.log('🧪 RUNNING GYM MANAGER AUTOMATION SYSTEM — END-TO-END TEST SUITE');
  console.log('====================================================================\n');

  // 1. Reset & Seed Database
  const today = getTodayIST();
  const db = resetDatabase(today);
  console.log(`✅ [STEP 1] Reset & Seeded 4-Tab Google Sheets DB for Today IST: ${today}`);
  assert.strictEqual(db.Members.length, 7, 'Should seed 7 initial members');
  assert.strictEqual(fs.existsSync(path.join(SHEETS_CSV_DIR, 'Members.csv')), true, 'Members.csv should exist');
  assert.strictEqual(fs.existsSync(path.join(SHEETS_CSV_DIR, 'Payments.csv')), true, 'Payments.csv should exist');
  assert.strictEqual(fs.existsSync(path.join(SHEETS_CSV_DIR, 'Reminder_Logs.csv')), true, 'Reminder_Logs.csv should exist');
  assert.strictEqual(fs.existsSync(path.join(SHEETS_CSV_DIR, 'Gym_Settings.csv')), true, 'Gym_Settings.csv should exist');

  // 2. Unit Test: Indian Phone Normalization & Month-End Date Clamping
  console.log('\n✅ [STEP 2] Verifying Indian Phone Normalization & Month-End Date Clamping...');
  assert.strictEqual(normalizeIndianPhone('+91 98765-43210').phoneE164, '919876543210');
  assert.strictEqual(normalizeIndianPhone('09876543210').phoneE164, '919876543210');
  assert.strictEqual(normalizeIndianPhone('12345').valid, false);

  // Non-leap year Jan 31 + 1 month -> Feb 28
  assert.strictEqual(addMonthsClamped('2026-01-31', 1), '2026-02-28');
  // Leap year Jan 31 + 1 month -> Feb 29
  assert.strictEqual(addMonthsClamped('2024-01-31', 1), '2024-02-29');
  // May 31 + 1 month -> June 30
  assert.strictEqual(addMonthsClamped('2026-05-31', 1), '2026-06-30');
  console.log('   ✔ 2026-01-31 + 1 Month -> 2026-02-28 (Clamped accurately)');
  console.log('   ✔ 2024-01-31 + 1 Month -> 2024-02-29 (Leap Year clamped accurately)');

  // 3. Test Workflow 1: New Member Registration (with Jan 31 joining date)
  console.log('\n✅ [STEP 3] Testing Workflow 1: Member Registration & Duplicate Phone Guard...');
  const wf1Success = executeWorkflow1Registration({
    name: 'Karan Johar',
    phone: '+91 98111 22333',
    email: 'karan.j@example.in',
    plan: 'Monthly',
    durationMonths: 1,
    joiningDate: '2026-01-31',
    paymentStatus: 'Paid',
    paymentMethod: 'UPI',
    whatsappConsent: true,
  });
  assert.strictEqual(wf1Success.ok, true, 'Registration should succeed');
  assert.strictEqual(wf1Success.member.Phone, '919811122333');
  assert.strictEqual(wf1Success.member.Expiry_Date, '2026-02-28', 'Jan 31 + 1M must equal 2026-02-28');
  console.log(`   ✔ Registered ${wf1Success.member.Name} (${wf1Success.member.Member_ID}) | Expiry: ${wf1Success.member.Expiry_Date}`);

  // Test Duplicate Phone Rejection
  const wf1Duplicate = executeWorkflow1Registration({
    name: 'Karan Duplicate',
    phone: '09811122333', // Same number formatted with leading 0
    email: 'dup@example.in',
    plan: 'Monthly',
    joiningDate: today,
  });
  assert.strictEqual(wf1Duplicate.ok, false, 'Duplicate phone must be rejected');
  assert.strictEqual(wf1Duplicate.statusCode, 409, 'Duplicate phone must return HTTP 409');
  console.log(`   ✔ Duplicate phone 09811122333 blocked with 409: ${wf1Duplicate.error}`);

  // 4. Test Workflow 2: Automated Membership Expiry Reminders
  console.log('\n✅ [STEP 4] Testing Workflow 2: Morning Expiry Reminders (3-Day & Today + Consent + Deduplication)...');
  const wf2FirstRun = executeWorkflow2ExpiryReminders({ referenceDate: today });
  assert.strictEqual(wf2FirstRun.ok, true);
  // Seeded DB has Priya Patel (3 days, Consent TRUE), Rohan Verma (Today, Consent TRUE), and Ananya Gupta (3 days, Consent FALSE)
  assert.strictEqual(wf2FirstRun.sentCount, 2, 'Should send 2 reminders (Priya 3-day & Rohan Today) and skip Ananya (Consent=FALSE)');
  console.log(`   ✔ First Run: Sent ${wf2FirstRun.sentCount} reminders (GYM-1002 3DAY_EXPIRY & GYM-1003 TODAY_EXPIRY), Skipped ${wf2FirstRun.skippedCount} (Ananya: No Consent)`);

  // Run Workflow 2 a second time on the exact same day -> must send 0 (Idempotency)
  const wf2SecondRun = executeWorkflow2ExpiryReminders({ referenceDate: today });
  assert.strictEqual(wf2SecondRun.sentCount, 0, 'Second run on same day must send 0 duplicate reminders');
  console.log(`   ✔ Second Run (Same Day): Sent ${wf2SecondRun.sentCount} reminders (100% duplicate prevention verified)`);

  // 5. Test Workflow 3: Razorpay Webhook Signature Verification, Idempotency & Expiry Extension
  console.log('\n✅ [STEP 5] Testing Workflow 3: Razorpay Webhook HMAC-SHA256 Verification & Expiry Extension...');
  const linkBundle = generateRazorpayPaymentLink({
    memberId: 'GYM-1004', // Sneha Nair (Expired member)
    plan: 'Quarterly',
    durationMonths: 3,
    amount: 4000,
  });
  assert.strictEqual(linkBundle.ok, true);

  // 5A. Test Tampered Signature -> Must be rejected with 401
  const wf3Tampered = executeWorkflow3PaymentProcessing({
    source: 'RAZORPAY_WEBHOOK',
    rawBodyString: linkBundle.webhookSimulator.rawBodyString,
    signatureHeader: 'tampered_invalid_signature_12345',
    parsedPayload: linkBundle.webhookSimulator.parsedPayload,
  });
  assert.strictEqual(wf3Tampered.ok, false, 'Tampered webhook signature must fail');
  assert.strictEqual(wf3Tampered.statusCode, 401, 'Tampered webhook must return 401');
  console.log(`   ✔ Tampered Razorpay webhook rejected (401): ${wf3Tampered.error}`);

  // 5B. Test Valid HMAC-SHA256 Signature -> Must succeed and extend GYM-1004 expiry by 3 months from today
  const wf3Valid = executeWorkflow3PaymentProcessing({
    source: 'RAZORPAY_WEBHOOK',
    rawBodyString: linkBundle.webhookSimulator.rawBodyString,
    signatureHeader: linkBundle.webhookSimulator.validHmacSha256Signature,
    parsedPayload: linkBundle.webhookSimulator.parsedPayload,
  });
  assert.strictEqual(wf3Valid.ok, true, 'Valid signed webhook must succeed');
  assert.strictEqual(wf3Valid.newExpiryDate, addMonthsClamped(today, 3));
  console.log(`   ✔ Valid HMAC-SHA256 Webhook processed! Member GYM-1004 expiry extended: ${wf3Valid.previousExpiryDate} -> ${wf3Valid.newExpiryDate}`);

  // 5C. Replay the exact same Razorpay Webhook -> Must be blocked by Idempotency check (409)
  const wf3Replay = executeWorkflow3PaymentProcessing({
    source: 'RAZORPAY_WEBHOOK',
    rawBodyString: linkBundle.webhookSimulator.rawBodyString,
    signatureHeader: linkBundle.webhookSimulator.validHmacSha256Signature,
    parsedPayload: linkBundle.webhookSimulator.parsedPayload,
  });
  assert.strictEqual(wf3Replay.ok, false, 'Replayed webhook reference must be skipped');
  assert.strictEqual(wf3Replay.statusCode, 409, 'Replayed webhook must return 409');
  console.log(`   ✔ Replayed Razorpay webhook blocked (409 Idempotency): ${wf3Replay.error}`);

  // 6. Test Workflow 4: Daily Gym Report
  console.log('\n✅ [STEP 6] Testing Workflow 4: Automated Daily Gym Report...');
  const wf4Report = executeWorkflow4DailyReport({ referenceDate: today });
  assert.strictEqual(wf4Report.ok, true);
  assert.strictEqual(wf4Report.stats.totalRegisteredMembers, 8);
  assert.ok(wf4Report.htmlReport.includes('IronFit Pro Fitness Studio'), 'HTML report should include Gym Name');
  console.log(`   ✔ Daily Report Generated for ${wf4Report.stats.reportDate}:`);
  console.log(`     - Total Registered Members : ${wf4Report.stats.totalRegisteredMembers}`);
  console.log(`     - Currently Active Members : ${wf4Report.stats.currentlyActiveMembers}`);
  console.log(`     - Expired Memberships      : ${wf4Report.stats.expiredMemberships}`);
  console.log(`     - Expiring Today / 3 Days  : ${wf4Report.stats.membershipsExpiringToday} / ${wf4Report.stats.membershipsExpiringIn3Days}`);
  console.log(`     - Revenue Collected Today  : ₹${wf4Report.stats.totalRevenueCollectedToday.toLocaleString('en-IN')}`);

  console.log('\n====================================================================');
  console.log('🎉 ALL 6 END-TO-END WORKFLOW & SECURITY TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================================');
}

runAllTests();
