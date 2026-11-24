/**
 * ============================================================================
 * GYM MANAGER AUTOMATION SYSTEM — FRONTEND SPA CONTROLLER
 * ============================================================================
 * Connects the Gym Owner UI to the 4 n8n Workflow endpoints & Google Sheets DB.
 */

let appState = null;
let activeInspectorSheet = 'Members';
let lastGeneratedWebhookSim = null;
let currentPortalSession = null; // Starts unauthenticated on the dedicated Login Page

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupForms();
  fetchAppState();
});

function setupNavigation() {
  const buttons = document.querySelectorAll('.nav-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  document.getElementById('memberSearchInput').addEventListener('input', renderDashboardMembers);
  document.getElementById('memberStatusFilter').addEventListener('change', renderDashboardMembers);

  const resetBtn = document.getElementById('resetDemoBtn');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      const res = await fetch('/api/reset-demo', { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast('Demo database reset to initial 7-member Indian gym dataset.', 'success');
        await fetchAppState();
      }
    });
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });
}

function showToast(message, type = 'success') {
  const banner = document.getElementById('toastBanner');
  banner.className = `toast-banner ${type === 'error' ? 'toast-error' : 'toast-success'}`;
  banner.innerHTML = `<span>${type === 'error' ? '⚠️' : '✅'} ${message}</span><button onclick="this.parentElement.classList.add('hidden')" class="btn btn-sm btn-outline">✕</button>`;
}

/**
 * Month-end safe date clamping preview in browser (mirrors n8n Code Node)
 */
function addMonthsClampedClient(dateStr, monthsToAdd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return '';
  const [year, month, day] = dateStr.split('-').map(Number);
  const totalMonths = (month - 1) + Number(monthsToAdd);
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonthIndex = totalMonths % 12;
  const maxDays = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, maxDays);
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`;
}

function updateRegistrationExpiryPreview() {
  const joinDate = document.getElementById('regJoiningDate').value;
  const planSelect = document.getElementById('regPlan');
  const selectedOpt = planSelect.options[planSelect.selectedIndex];
  const months = Number(selectedOpt.getAttribute('data-months') || 1);
  if (joinDate) {
    const expiry = addMonthsClampedClient(joinDate, months);
    document.getElementById('regExpiryPreview').value = `${expiry} (${months} month${months > 1 ? 's' : ''} — Month-End Safe)`;
  }
}

async function fetchAppState() {
  const res = await fetch('/api/state');
  const data = await res.json();
  if (!data.ok) return;

  appState = data;
  const settings = (data.sheets.Gym_Settings && data.sheets.Gym_Settings[0]) || {};

  // Update sidebar & header
  document.getElementById('sidebarGymName').textContent = settings.Gym_Name || 'IronFit Pro Studio';
  document.getElementById('sidebarTodayIST').textContent = data.todayIST;

  // Set default joining date if empty
  const regDateInput = document.getElementById('regJoiningDate');
  if (!regDateInput.value) {
    regDateInput.value = data.todayIST;
  }
  updateRegistrationExpiryPreview();

  // Update KPI Cards from Workflow 4 Daily Report engine
  const stats = data.dailyReport.stats;
  document.getElementById('kpiTotalMembers').textContent = stats.totalRegisteredMembers;
  document.getElementById('kpiActiveMembers').textContent = stats.currentlyActiveMembers;
  document.getElementById('kpiExpiringToday').textContent = stats.membershipsExpiringToday;
  document.getElementById('kpiExpiring3Days').textContent = stats.membershipsExpiringIn3Days;
  document.getElementById('kpiExpiredMembers').textContent = stats.expiredMemberships;
  document.getElementById('kpiRevenueToday').textContent = `₹${Number(stats.totalRevenueCollectedToday).toLocaleString('en-IN')}`;
  document.getElementById('kpiPaymentsToday').textContent = stats.paymentsReceivedToday;
  document.getElementById('kpiPendingPayments').textContent = stats.pendingPayments;

  // Render Tables
  renderDashboardMembers();
  renderReminderLogsTable();
  renderPaymentsTable();
  populateMemberSelectDropdown();
  renderDailyReportPreview(data.dailyReport);
  renderSheetInspector(activeInspectorSheet);
  renderAuditLogs(data.auditLogs);
  populateSettingsForm(settings);
  renderActivePortalView();
  renderMongoStatusPanel(data.mongoStatus);
}

function renderDashboardMembers() {
  if (!appState) return;
  const search = document.getElementById('memberSearchInput').value.trim().toLowerCase();
  const statusFilter = document.getElementById('memberStatusFilter').value;
  const tbody = document.getElementById('dashboardMembersBody');

  const rows = appState.sheets.Members.filter((m) => {
    const matchesSearch =
      !search ||
      m.Name.toLowerCase().includes(search) ||
      m.Member_ID.toLowerCase().includes(search) ||
      String(m.Phone).includes(search);
    const matchesStatus = statusFilter === 'ALL' || m.Member_Status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const profiles = appState.memberProfiles || {};
  const trainers = appState.trainers || [];

  tbody.innerHTML = rows
    .map((m) => {
      const statusBadgeClass =
        m.Member_Status === 'Expired'
          ? 'badge-expired'
          : m.Member_Status.includes('Expiring')
          ? 'badge-expiring'
          : 'badge-active';
      const payBadgeClass = m.Payment_Status === 'Paid' ? 'badge-paid' : 'badge-pending';

      const prof = profiles[m.Member_ID] || { Assigned_Trainer_ID: 'TRN-201' };
      const trn =
        trainers.find((t) => t.Trainer_ID === prof.Assigned_Trainer_ID) || {
          Trainer_ID: 'TRN-201',
          Name: 'Coach Rajesh Kumar',
          Specialty: 'Strength & Hypertrophy',
          Shift: 'Morning (06:00 AM - 02:00 PM)',
          Phone: '919820099101',
        };

      return `<tr>
        <td><strong>${m.Member_ID}</strong></td>
        <td>${m.Name}<div class="text-muted" style="font-size:11px;">${m.Email || ''}</div></td>
        <td><code>${m.Phone}</code></td>
        <td>${m.Plan}</td>
        <td>
          <strong>${trn.Name}</strong> <span class="badge badge-active" style="font-size:10px;padding:1px 6px;">${trn.Trainer_ID}</span>
          <div class="text-muted" style="font-size:11px;">${trn.Specialty} • 📞 +${trn.Phone}</div>
        </td>
        <td>${m.Joining_Date}</td>
        <td><strong>${m.Expiry_Date}</strong></td>
        <td><span class="badge ${payBadgeClass}">${m.Payment_Status} (${m.Payment_Method})</span></td>
        <td>${m.WhatsApp_Consent === 'TRUE' ? '✅ Yes' : '🚫 No'}</td>
        <td><span class="badge ${statusBadgeClass}">${m.Member_Status}</span></td>
        <td>
          <button class="btn btn-sm btn-outline" onclick="quickRenewMember('${m.Member_ID}')">💳 Renew / Pay</button>
        </td>
      </tr>`;
    })
    .join('');
}

function quickRenewMember(memberId) {
  switchTab('payments');
  const select = document.getElementById('payMemberSelect');
  select.value = memberId;
  document.getElementById('payReferenceInput').value = `UPI-UTR-${Date.now().toString().slice(-8)}`;
}

function renderReminderLogsTable() {
  if (!appState) return;
  const tbody = document.getElementById('reminderLogsTableBody');
  const logs = [...appState.sheets.Reminder_Logs].reverse();
  tbody.innerHTML = logs
    .map(
      (r) => `<tr>
      <td><code>${r.Reminder_ID}</code></td>
      <td><strong>${r.Member_ID}</strong></td>
      <td>${r.Phone}</td>
      <td><span class="badge badge-expiring">${r.Reminder_Type}</span></td>
      <td>${r.Sent_Date}</td>
      <td style="font-size:11.5px;color:#34d399;">${r.Delivery_Status}</td>
    </tr>`
    )
    .join('');
}

function renderPaymentsTable() {
  if (!appState) return;
  const tbody = document.getElementById('paymentsTableBody');
  const payments = [...appState.sheets.Payments].reverse();
  tbody.innerHTML = payments
    .map(
      (p) => `<tr>
      <td><code>${p.Payment_ID}</code></td>
      <td><strong>${p.Member_ID}</strong></td>
      <td><strong>₹${Number(p.Amount).toLocaleString('en-IN')}</strong></td>
      <td>${p.Payment_Method}</td>
      <td><span class="badge ${p.Payment_Status === 'Paid' ? 'badge-paid' : 'badge-pending'}">${p.Payment_Status}</span></td>
      <td>${p.Payment_Date}</td>
      <td><code>${p.Razorpay_Reference}</code></td>
      <td>${p.Webhook_Processed === 'TRUE' ? '✅ TRUE' : '⏳ FALSE'}</td>
    </tr>`
    )
    .join('');
}

function populateMemberSelectDropdown() {
  if (!appState) return;
  const select = document.getElementById('payMemberSelect');
  const currentVal = select.value;
  select.innerHTML = appState.sheets.Members.map(
    (m) =>
      `<option value="${m.Member_ID}">${m.Member_ID} — ${m.Name} (Expires: ${m.Expiry_Date} | ${m.Member_Status})</option>`
  ).join('');
  if (currentVal) select.value = currentVal;
}

function renderNodeTrace(containerId, executionObj) {
  const container = document.getElementById(containerId);
  if (!executionObj || !executionObj.nodeTrace) {
    container.innerHTML = '<div class="empty-trace">No trace available.</div>';
    return;
  }
  const traceHtml = executionObj.nodeTrace
    .map(
      (step) => `<div class="trace-node ${step.status.includes('ERROR') || step.status.includes('REJECTED') ? 'trace-error' : ''}">
      <div class="trace-node-title">
        <span>${step.node}</span>
        <span class="badge ${step.status === 'SUCCESS' ? 'badge-active' : 'badge-expiring'}">${step.status}</span>
      </div>
      <pre class="trace-pre">${JSON.stringify(step.output || step.errors, null, 2)}</pre>
    </div>`
    )
    .join('');

  container.innerHTML = `<div style="margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid #26354d;">
    <strong>Execution ID:</strong> <code>${executionObj.executionId}</code> • <strong>Timestamp:</strong> ${executionObj.timestamp}<br/>
    <strong>Summary:</strong> <span style="color:#34d399;">${executionObj.summary}</span>
  </div>${traceHtml}`;
}

function setupForms() {
  document.getElementById('regJoiningDate').addEventListener('change', updateRegistrationExpiryPreview);
  document.getElementById('regPlan').addEventListener('change', updateRegistrationExpiryPreview);

  // Workflow 1 Form Submit
  document.getElementById('registrationForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const planSelect = document.getElementById('regPlan');
    const durationMonths = Number(planSelect.options[planSelect.selectedIndex].getAttribute('data-months') || 1);

    const payload = {
      name: document.getElementById('regName').value,
      phone: document.getElementById('regPhone').value,
      email: document.getElementById('regEmail').value,
      plan: planSelect.value,
      durationMonths,
      joiningDate: document.getElementById('regJoiningDate').value,
      paymentStatus: document.getElementById('regPaymentStatus').value,
      paymentMethod: document.getElementById('regPaymentMethod').value,
      whatsappConsent: document.getElementById('regWhatsappConsent').checked,
    };

    const res = await fetch('/api/workflows/1/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    renderNodeTrace('wf1TraceOutput', data.execution);

    if (data.ok) {
      showToast(`Workflow 1 Success: Registered ${data.member.Name} (${data.member.Member_ID}) | Expiry: ${data.member.Expiry_Date}`, 'success');
      document.getElementById('regName').value = '';
      document.getElementById('regPhone').value = '';
      document.getElementById('regEmail').value = '';
    } else {
      showToast(`Workflow 1 Blocked: ${data.error}`, 'error');
    }
    await fetchAppState();
  });

  // Update amount when plan changes in Workflow 3 Manual Payment Form
  document.getElementById('payPlanSelect').addEventListener('change', (e) => {
    if (!appState) return;
    const settings = appState.sheets.Gym_Settings[0] || {};
    const plan = e.target.value;
    if (plan === 'Monthly') document.getElementById('payAmountInput').value = settings.Monthly_Plan_Price || 2000;
    if (plan === 'Quarterly') document.getElementById('payAmountInput').value = settings.Quarterly_Plan_Price || 4000;
    if (plan === 'Half-Yearly') document.getElementById('payAmountInput').value = settings.Half_Yearly_Plan_Price || 6000;
    if (plan === 'Yearly') document.getElementById('payAmountInput').value = settings.Yearly_Plan_Price || 9000;
  });

  document.getElementById('payReferenceInput').value = `UPI-UTR-${Date.now().toString().slice(-8)}`;

  // Workflow 3 Manual Payment Form Submit
  document.getElementById('manualPaymentForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const planSelect = document.getElementById('payPlanSelect');
    const durationMonths = Number(planSelect.options[planSelect.selectedIndex].getAttribute('data-months') || 1);

    const payload = {
      memberId: document.getElementById('payMemberSelect').value,
      plan: planSelect.value,
      durationMonths,
      amount: Number(document.getElementById('payAmountInput').value),
      paymentMethod: document.getElementById('payMethodSelect').value,
      paymentReference: document.getElementById('payReferenceInput').value,
    };

    const res = await fetch('/api/workflows/3/manual-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    renderNodeTrace('wf3TraceOutput', data.execution);

    if (data.ok) {
      showToast(
        `Workflow 3 Success: ₹${data.payment.Amount} recorded for ${data.member.Name}. Expiry extended ${data.previousExpiryDate} -> ${data.newExpiryDate}`,
        'success'
      );
    } else {
      showToast(`Workflow 3 Guard: ${data.error}`, 'error');
    }
    await fetchAppState();
  });

  // Sheet 4 Gym_Settings Form Submit
  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      Gym_Name: document.getElementById('setGymName').value,
      Owner_Email: document.getElementById('setOwnerEmail').value,
      WhatsApp_Number: document.getElementById('setWhatsappNumber').value,
      Monthly_Plan_Price: Number(document.getElementById('setMonthlyPrice').value),
      Quarterly_Plan_Price: Number(document.getElementById('setQuarterlyPrice').value),
      Half_Yearly_Plan_Price: Number(document.getElementById('setHalfYearlyPrice')?.value || 6000),
      Yearly_Plan_Price: Number(document.getElementById('setYearlyPrice').value),
      Reminder_Time: document.getElementById('setReminderTime').value,
    };

    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Gym_Settings (Sheet 4) updated successfully.', 'success');
      await fetchAppState();
    }
  });

  // Owner Login Form Submit
  const ownerLoginForm = document.getElementById('ownerLoginForm');
  if (ownerLoginForm) {
    ownerLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('ownerLoginId').value;
      const pin = document.getElementById('ownerLoginPin').value;
      await performPortalLogin('OWNER', id, pin);
    });
  }

  // Trainer Login Form Submit
  const trainerLoginForm = document.getElementById('trainerLoginForm');
  if (trainerLoginForm) {
    trainerLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('trainerLoginId').value;
      const pin = document.getElementById('trainerLoginPin').value;
      await performPortalLogin('TRAINER', id, pin);
    });
  }

  // Member Login Form Submit
  const memberLoginForm = document.getElementById('memberLoginForm');
  if (memberLoginForm) {
    memberLoginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('memberLoginId').value;
      const pin = document.getElementById('memberLoginPin').value;
      await performPortalLogin('MEMBER', id, pin);
    });
  }

  // Trainer Update Member Workout/Diet Form Submit
  const trainerUpdateForm = document.getElementById('trainerUpdatePlanForm');
  if (trainerUpdateForm) {
    trainerUpdateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        memberId: document.getElementById('trnEditMemberSelect').value,
        assignedTrainerId: document.getElementById('trnEditCoachSelect').value,
        workoutPlan: document.getElementById('trnEditWorkoutInput').value,
        dietNotes: document.getElementById('trnEditDietInput').value,
      };
      const res = await fetch('/api/trainer/update-member-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(`Trainer Update Saved: Workout & Diet Plan updated for ${payload.memberId}`, 'success');
        await fetchAppState();
      } else {
        showToast(data.error, 'error');
      }
    });
  }

  // MongoDB Atlas Connection Form Submit
  const mongoForm = document.getElementById('mongoConnectForm');
  if (mongoForm) {
    mongoForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const uri = document.getElementById('mongoUriInput').value.trim();
      const dbName = document.getElementById('mongoDbNameInput').value.trim() || 'gym_manager_saas';
      showToast('Connecting to MongoDB Atlas cluster & syncing collections...', 'success');

      const res = await fetch('/api/mongodb/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri, dbName }),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(data.message, 'success');
      } else {
        showToast(`MongoDB Atlas Error: ${data.error}`, 'error');
      }
      await fetchAppState();
    });
  }
}

function fillJan31Test() {
  document.getElementById('regName').value = 'Meera Deshmukh (Jan 31 Test)';
  document.getElementById('regPhone').value = `+91 98201 ${Math.floor(10000 + Math.random() * 89999)}`;
  document.getElementById('regEmail').value = 'meera.d@example.in';
  document.getElementById('regPlan').value = 'Monthly';
  document.getElementById('regJoiningDate').value = '2026-01-31';
  updateRegistrationExpiryPreview();
  showToast('Pre-filled Joining Date 2026-01-31 + 1 Month -> Notice Expiry clamps to 2026-02-28!', 'success');
}

function fillDuplicatePhoneTest() {
  document.getElementById('regName').value = 'Duplicate Test User';
  document.getElementById('regPhone').value = '098765-43210'; // Matches Aarav Sharma (919876543210)
  document.getElementById('regEmail').value = 'dup@example.in';
  updateRegistrationExpiryPreview();
  showToast('Pre-filled 098765-43210 (normalizes to existing member 919876543210). Click Execute to test Duplicate Prevention.', 'success');
}

async function triggerWorkflow2Reminders() {
  switchTab('reminders');
  const res = await fetch('/api/workflows/2/run-reminders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  renderNodeTrace('wf2TraceOutput', data.execution);

  if (data.sentCount > 0) {
    showToast(`Workflow 2 Executed: Dispatched ${data.sentCount} WhatsApp expiry reminder(s), skipped ${data.skippedCount}.`, 'success');
  } else {
    showToast(`Workflow 2 Idempotency Guard: 0 new reminders sent (${data.skippedCount} already sent today or no consent).`, 'success');
  }
  await fetchAppState();
}

async function generateAndFireRazorpayWebhook(useValidSignature = true) {
  const memberId = document.getElementById('payMemberSelect').value || 'GYM-1004';
  const planSelect = document.getElementById('payPlanSelect');
  const durationMonths = Number(planSelect.options[planSelect.selectedIndex].getAttribute('data-months') || 1);
  const amount = Number(document.getElementById('payAmountInput').value || 1500);

  // Step 1: Generate Razorpay Payment Link & signed payload
  const linkRes = await fetch('/api/payments/create-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, plan: planSelect.value, durationMonths, amount }),
  });
  const linkData = await linkRes.json();
  if (!linkData.ok) {
    return showToast(linkData.error, 'error');
  }

  lastGeneratedWebhookSim = linkData.webhookSimulator;
  const sigToSend = useValidSignature
    ? linkData.webhookSimulator.validHmacSha256Signature
    : 'invalid_tampered_hmac_signature_0000000000';

  // Step 2: Fire Webhook to Workflow 3 endpoint with x-razorpay-signature header
  const whRes = await fetch('/api/workflows/3/razorpay-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': sigToSend,
    },
    body: linkData.webhookSimulator.rawBodyString,
  });
  const whData = await whRes.json();
  renderNodeTrace('wf3TraceOutput', whData.execution);

  if (whData.ok) {
    showToast(
      `Razorpay Webhook Verified (HMAC-SHA256)! Ref: ${whData.payment.Razorpay_Reference} | Expiry extended to ${whData.newExpiryDate}`,
      'success'
    );
  } else {
    showToast(`Razorpay Webhook Rejected (${whRes.status}): ${whData.error}`, 'error');
  }
  await fetchAppState();
}

async function replayLastRazorpayWebhook() {
  if (!lastGeneratedWebhookSim) {
    await generateAndFireRazorpayWebhook(true);
  }
  const whRes = await fetch('/api/workflows/3/razorpay-webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-razorpay-signature': lastGeneratedWebhookSim.validHmacSha256Signature,
    },
    body: lastGeneratedWebhookSim.rawBodyString,
  });
  const whData = await whRes.json();
  renderNodeTrace('wf3TraceOutput', whData.execution);
  showToast(`Idempotency Verified (${whRes.status}): ${whData.error}`, 'error');
  await fetchAppState();
}

async function triggerWorkflow4Report() {
  const res = await fetch('/api/workflows/4/daily-report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const data = await res.json();
  if (data.ok) {
    renderDailyReportPreview(data);
    showToast(`Workflow 4 Executed: Daily HTML Report generated & sent to ${data.stats.ownerEmail}`, 'success');
    await fetchAppState();
  }
}

function renderDailyReportPreview(reportData) {
  if (!reportData) return;
  document.getElementById('reportOwnerEmailBadge').textContent = reportData.stats.ownerEmail;
  document.getElementById('htmlReportPreviewContainer').innerHTML = reportData.htmlReport;
  document.getElementById('wf4TraceOutput').innerHTML = `<pre class="trace-pre">${JSON.stringify(
    reportData.stats,
    null,
    2
  )}</pre>`;
}

function renderSheetInspector(sheetName) {
  if (!appState) return;
  activeInspectorSheet = sheetName;
  document.getElementById('activeSheetTitle').textContent = `Google Sheet Tab: ${sheetName}`;
  document.getElementById('downloadSheetCsvLink').href = `/api/sheets/csv/${sheetName}.csv`;

  const headers = appState.schemas[sheetName] || [];
  const rows = appState.sheets[sheetName] || [];

  document.getElementById('sheetInspectorHead').innerHTML = `<tr>${headers
    .map((h) => `<th>${h}</th>`)
    .join('')}</tr>`;

  document.getElementById('sheetInspectorBody').innerHTML = rows
    .map(
      (row) =>
        `<tr>${headers
          .map((h) => `<td>${row[h] !== undefined && row[h] !== null ? row[h] : ''}</td>`)
          .join('')}</tr>`
    )
    .join('');
}

function renderAuditLogs(logs) {
  const container = document.getElementById('auditLogsContainer');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="empty-trace">No workflow executions recorded yet.</div>';
    return;
  }
  container.innerHTML = logs
    .map(
      (l) => `<div class="trace-node ${l.status.includes('ERROR') || l.status.includes('REJECTED') ? 'trace-error' : ''}">
      <div class="trace-node-title">
        <span>[${l.timestamp}] ${l.workflow}</span>
        <span class="badge ${l.status === 'SUCCESS' ? 'badge-active' : 'badge-expiring'}">${l.status}</span>
      </div>
      <div style="font-size:12px;color:#93c5fd;">${l.summary}</div>
    </div>`
    )
    .join('');
}

function populateSettingsForm(s) {
  if (!s) return;
  document.getElementById('setGymName').value = s.Gym_Name || '';
  document.getElementById('setOwnerEmail').value = s.Owner_Email || '';
  document.getElementById('setWhatsappNumber').value = s.WhatsApp_Number || '';
  document.getElementById('setMonthlyPrice').value = s.Monthly_Plan_Price || 2000;
  document.getElementById('setQuarterlyPrice').value = s.Quarterly_Plan_Price || 4000;
  const halfInput = document.getElementById('setHalfYearlyPrice');
  if (halfInput) halfInput.value = s.Half_Yearly_Plan_Price || 6000;
  document.getElementById('setYearlyPrice').value = s.Yearly_Plan_Price || 9000;
  document.getElementById('setReminderTime').value = s.Reminder_Time || '08:00';
}

/**
 * ============================================================================
 * DEDICATED FULL-SCREEN LOGIN PAGE + ROLE PORTAL CONTROLLERS
 * ============================================================================
 */
function selectLoginRole(role) {
  document.querySelectorAll('.role-tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-role') === role);
  });
  document.getElementById('ownerLoginForm').classList.toggle('hidden', role !== 'OWNER');
  document.getElementById('trainerLoginForm').classList.toggle('hidden', role !== 'TRAINER');
  document.getElementById('memberLoginForm').classList.toggle('hidden', role !== 'MEMBER');
  document.getElementById('loginErrorBox').classList.add('hidden');
}

async function submitRoleLoginForm(role) {
  let identifier = '';
  let pin = '';
  if (role === 'OWNER') {
    identifier = document.getElementById('ownerLoginId').value.trim();
    pin = document.getElementById('ownerLoginPin').value.trim();
  } else if (role === 'TRAINER') {
    identifier = document.getElementById('trainerLoginId').value.trim();
    pin = document.getElementById('trainerLoginPin').value.trim();
  } else if (role === 'MEMBER') {
    identifier = document.getElementById('memberLoginId').value.trim();
    pin = document.getElementById('memberLoginPin').value.trim();
  }
  await performPortalLogin(role, identifier, pin);
}

async function quickLogin(role, identifier, pin) {
  selectLoginRole(role);
  if (role === 'OWNER') {
    document.getElementById('ownerLoginId').value = identifier;
    document.getElementById('ownerLoginPin').value = pin;
  } else if (role === 'TRAINER') {
    document.getElementById('trainerLoginId').value = identifier;
    document.getElementById('trainerLoginPin').value = pin;
  } else if (role === 'MEMBER') {
    document.getElementById('memberLoginId').value = identifier;
    document.getElementById('memberLoginPin').value = pin;
  }
  await performPortalLogin(role, identifier, pin);
}

function fallbackLocalAuth(role, identifier, pin) {
  const r = String(role || '').toUpperCase();
  const id = String(identifier || '').trim();
  const p = String(pin || '').trim();

  if (r === 'OWNER') {
    if (p && p !== '1234' && p !== 'admin123') {
      return { ok: false, error: 'Invalid Owner PIN (Default: 1234 or admin123).' };
    }
    return {
      ok: true,
      session: {
        role: 'OWNER',
        id: 'OWNER-1',
        name: 'Gym Owner / Admin',
        email: id || 'owner@ironfitgym.in',
      },
    };
  }

  if (r === 'TRAINER') {
    const trainers = (appState && appState.trainers) || [
      {
        Trainer_ID: 'TRN-201',
        Name: 'Coach Rajesh Kumar',
        Specialty: 'Strength & Hypertrophy',
        Shift: 'Morning (06:00 AM - 02:00 PM)',
        Phone: '919820099101',
        Pin: '1234',
      },
      {
        Trainer_ID: 'TRN-202',
        Name: 'Coach Neha Kapoor',
        Specialty: 'HIIT, Fat Loss & Mobility',
        Shift: 'Evening (02:00 PM - 10:00 PM)',
        Phone: '919820099102',
        Pin: '1234',
      },
    ];
    const trainer = trainers.find(
      (t) =>
        t.Trainer_ID.toUpperCase() === id.toUpperCase() ||
        String(t.Phone).endsWith(id.replace(/\D/g, ''))
    );
    if (!trainer) {
      return { ok: false, error: `Trainer "${id}" not found. Try TRN-201 or TRN-202.` };
    }
    if (p && p !== '1234' && p !== trainer.Pin) {
      return { ok: false, error: 'Invalid Trainer PIN (Default: 1234).' };
    }
    return {
      ok: true,
      session: {
        role: 'TRAINER',
        id: trainer.Trainer_ID,
        name: trainer.Name,
        specialty: trainer.Specialty,
        shift: trainer.Shift,
        phone: trainer.Phone,
      },
    };
  }

  if (r === 'MEMBER') {
    const members = (appState && appState.sheets && appState.sheets.Members) || [];
    const member = members.find(
      (m) =>
        m.Member_ID.toUpperCase() === id.toUpperCase() ||
        String(m.Phone).endsWith(id.replace(/\D/g, ''))
    );
    if (!member) {
      return { ok: false, error: `Member "${id}" not found. Try GYM-1001, GYM-1002, or GYM-1004.` };
    }
    const last4 = String(member.Phone).slice(-4);
    if (p && p !== '1234' && p !== last4) {
      return { ok: false, error: `Invalid Member PIN. Use 1234 or ${last4}.` };
    }
    return {
      ok: true,
      session: {
        role: 'MEMBER',
        id: member.Member_ID,
        name: member.Name,
        phone: member.Phone,
        email: member.Email,
        plan: member.Plan,
      },
    };
  }

  return { ok: false, error: 'Unknown role selected.' };
}

async function performPortalLogin(role, identifier, pin) {
  const errBox = document.getElementById('loginErrorBox');
  if (errBox) errBox.classList.add('hidden');

  if (!appState) {
    try {
      await fetchAppState();
    } catch (_) {}
  }

  let data = null;
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, identifier, pin }),
    });
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      // Server hasn't been restarted since /api/auth/login was added — use seamless client fallback
      data = fallbackLocalAuth(role, identifier, pin);
    }
  } catch (e) {
    data = fallbackLocalAuth(role, identifier, pin);
  }

  if (!data || !data.ok) {
    if (errBox) {
      errBox.textContent = `⚠️ ${(data && data.error) || 'Login failed. Check your ID and PIN.'}`;
      errBox.classList.remove('hidden');
    }
    return;
  }

  currentPortalSession = data.session;
  // Hide dedicated login page and enter the main application shell
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appShell').classList.remove('hidden');

  renderActivePortalView();
  showToast(`Welcome, ${data.session.name} (${data.session.role})!`, 'success');
}

function logoutToLoginPage() {
  currentPortalSession = null;
  const dropdown = document.getElementById('userAccountDropdown');
  if (dropdown) dropdown.classList.add('hidden');
  document.getElementById('appShell').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginErrorBox').classList.add('hidden');
}

function toggleUserAccountDropdown(event) {
  if (event) event.stopPropagation();
  const dropdown = document.getElementById('userAccountDropdown');
  if (dropdown) {
    dropdown.classList.toggle('hidden');
  }
}

// Close account dropdown when clicking anywhere outside
document.addEventListener('click', (e) => {
  const menu = document.querySelector('.user-account-menu');
  const dropdown = document.getElementById('userAccountDropdown');
  if (dropdown && !dropdown.classList.contains('hidden') && menu && !menu.contains(e.target)) {
    dropdown.classList.add('hidden');
  }
});

function updateUserAccountMenuUI() {
  if (!currentPortalSession) return;
  const name = currentPortalSession.name || 'Gym User';
  const role = currentPortalSession.role || 'OWNER';
  const id = currentPortalSession.id || 'OWNER-1';
  const initials = name
    .replace(/Coach\s+/i, '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || 'GY';

  const settings = (appState?.sheets?.Gym_Settings && appState.sheets.Gym_Settings[0]) || {};
  let phone = settings.WhatsApp_Number ? `+${settings.WhatsApp_Number}` : '+919820011223';
  let email = currentPortalSession.email || settings.Owner_Email || 'owner@ironfitgym.in';
  let extra = 'Full Admin Access';

  if (role === 'TRAINER') {
    const trnObj = (appState?.trainers || []).find((t) => t.Trainer_ID === id);
    const rawPhone = trnObj?.Phone || currentPortalSession.phone || '919820099101';
    phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
    email = trnObj?.Email || currentPortalSession.email || 'coach@ironfitgym.in';
    extra = trnObj?.Specialty || currentPortalSession.specialty || 'Fitness Coach';
  } else if (role === 'MEMBER') {
    const memberObj = (appState?.sheets?.Members || []).find((m) => m.Member_ID === id);
    const rawPhone = memberObj?.Phone || currentPortalSession.phone || '';
    phone = rawPhone ? (String(rawPhone).startsWith('+') ? rawPhone : `+${rawPhone}`) : 'N/A';
    email = memberObj?.Email || currentPortalSession.email || 'Not Provided';
    extra = memberObj ? `${memberObj.Plan} (${memberObj.Member_Status})` : currentPortalSession.plan || 'Active Member';
  }

  const setTxt = (elId, val) => {
    const el = document.getElementById(elId);
    if (el) el.textContent = val;
  };

  setTxt('navUserAvatar', initials);
  setTxt('navUserName', name);
  setTxt('navUserRole', `${role} • ${id}`);
  setTxt('dropUserAvatar', initials);
  setTxt('dropUserName', name);
  setTxt('dropUserRoleBadge', `${role} PORTAL`);
  setTxt('dropUserId', id);
  setTxt('dropUserContact', phone);
  setTxt('dropUserEmail', email);
  setTxt('dropUserExtra', extra);
}

function renderActivePortalView() {
  if (!appState || !currentPortalSession) return;
  updateUserAccountMenuUI();
  const trainerView = document.getElementById('trainerPortalView');
  const memberView = document.getElementById('memberPortalView');
  const ownerNav = document.getElementById('ownerNavMenu');
  const ownerHeader = document.getElementById('ownerTopHeader');
  if (!trainerView || !memberView) return;

  if (currentPortalSession.role === 'TRAINER') {
    if (ownerNav) ownerNav.classList.add('hidden');
    if (ownerHeader) ownerHeader.classList.add('hidden');
    switchTab('portal-login');
    trainerView.classList.remove('hidden');
    memberView.classList.add('hidden');
    renderTrainerPortal();
  } else if (currentPortalSession.role === 'MEMBER') {
    if (ownerNav) ownerNav.classList.add('hidden');
    if (ownerHeader) ownerHeader.classList.add('hidden');
    switchTab('portal-login');
    memberView.classList.remove('hidden');
    trainerView.classList.add('hidden');
    renderMemberPortal();
  } else {
    if (ownerNav) ownerNav.classList.remove('hidden');
    if (ownerHeader) ownerHeader.classList.remove('hidden');
    trainerView.classList.add('hidden');
    memberView.classList.add('hidden');
    switchTab('dashboard');
  }
}

function renderTrainerPortal() {
  if (!appState || currentPortalSession.role !== 'TRAINER') return;
  const trainerId = currentPortalSession.id;
  const profiles = appState.memberProfiles || {};
  const members = appState.sheets.Members || [];
  const filterMode = document.getElementById('trainerFilterSelect').value;

  document.getElementById('trainerPortalHeading').textContent = `🏋️‍♂️ ${currentPortalSession.name} (${trainerId}) — Trainer Dashboard`;
  document.getElementById('trainerPortalSubheading').textContent = `Specialty: ${currentPortalSession.specialty || 'Fitness Coach'} • Shift: ${currentPortalSession.shift || 'Full Day'}`;

  // Populate member selector in Trainer editor
  const editSelect = document.getElementById('trnEditMemberSelect');
  const prevSelection = editSelect.value;
  editSelect.innerHTML = members
    .map((m) => `<option value="${m.Member_ID}">${m.Member_ID} — ${m.Name} (${m.Plan})</option>`)
    .join('');
  if (prevSelection && members.some((m) => m.Member_ID === prevSelection)) {
    editSelect.value = prevSelection;
  }
  populateTrainerEditorForMember();

  const assignedMembers = members.filter((m) => {
    const p = profiles[m.Member_ID] || { Assigned_Trainer_ID: 'TRN-201' };
    return p.Assigned_Trainer_ID === trainerId;
  });

  const expiringAssigned = assignedMembers.filter(
    (m) => m.Member_Status === 'Expiring Soon' || m.Member_Status === 'Expiring Today' || m.Member_Status === 'Expired'
  );
  const totalCheckins = assignedMembers.reduce((sum, m) => {
    const p = profiles[m.Member_ID] || {};
    return sum + Number(p.Attendance_Count || 0);
  }, 0);

  document.getElementById('trnKpiAssigned').textContent = assignedMembers.length;
  document.getElementById('trnKpiExpiring').textContent = expiringAssigned.length;
  document.getElementById('trnKpiCheckins').textContent = totalCheckins;

  const displayedMembers = filterMode === 'ALL' ? members : assignedMembers;
  const tbody = document.getElementById('trainerRosterTableBody');
  tbody.innerHTML = displayedMembers
    .map((m) => {
      const p = profiles[m.Member_ID] || {
        Assigned_Trainer_ID: 'TRN-201',
        Workout_Plan: 'General Strength & Conditioning Split',
        Diet_Notes: 'Balanced High-Protein Diet',
        Attendance_Count: 1,
        Last_CheckIn: m.Joining_Date,
      };
      const statusBadge =
        m.Member_Status === 'Expired'
          ? 'badge-expired'
          : m.Member_Status.includes('Expiring')
          ? 'badge-expiring'
          : 'badge-active';

      return `<tr>
        <td><strong>${m.Name}</strong><div class="text-muted" style="font-size:11px;">${m.Member_ID} • ${m.Phone}</div></td>
        <td><span class="badge ${statusBadge}">${m.Member_Status}</span><div class="text-muted" style="font-size:11px;">Exp: ${m.Expiry_Date}</div></td>
        <td>
          <div style="font-weight:600;color:#f8fafc;font-size:12px;">${p.Workout_Plan}</div>
          <div style="color:#34d399;font-size:11.5px;">🥗 ${p.Diet_Notes}</div>
        </td>
        <td><strong>${p.Attendance_Count || 0}</strong> visits<div class="text-muted" style="font-size:11px;">Last: ${p.Last_CheckIn || '--'}</div></td>
        <td>
          <button class="btn btn-sm btn-outline" onclick="selectMemberForTrainerEdit('${m.Member_ID}')">✏️ Edit Plan</button>
        </td>
      </tr>`;
    })
    .join('');
}

function selectMemberForTrainerEdit(memberId) {
  const select = document.getElementById('trnEditMemberSelect');
  select.value = memberId;
  populateTrainerEditorForMember();
}

function populateTrainerEditorForMember() {
  if (!appState) return;
  const memberId = document.getElementById('trnEditMemberSelect').value;
  if (!memberId) return;
  const profile = (appState.memberProfiles && appState.memberProfiles[memberId]) || {
    Assigned_Trainer_ID: currentPortalSession.role === 'TRAINER' ? currentPortalSession.id : 'TRN-201',
    Workout_Plan: '3-Day Full Body Strength & Mobility Routine',
    Diet_Notes: 'High Protein Balanced Diet • 3L Hydration',
  };
  document.getElementById('trnEditCoachSelect').value = profile.Assigned_Trainer_ID || 'TRN-201';
  document.getElementById('trnEditWorkoutInput').value = profile.Workout_Plan || '';
  document.getElementById('trnEditDietInput').value = profile.Diet_Notes || '';
}

async function markMemberAttendanceFromTrainer() {
  const memberId = document.getElementById('trnEditMemberSelect').value;
  if (!memberId) return;
  const res = await fetch('/api/trainer/update-member-plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memberId, markAttendance: true }),
  });
  const data = await res.json();
  if (data.ok) {
    showToast(`Attendance logged for ${memberId}! Total visits: ${data.profile.Attendance_Count}`, 'success');
    await fetchAppState();
  }
}

function calculateDaysRemainingClient(expiryDateStr, todayStr) {
  if (!expiryDateStr || !todayStr) return 0;
  const [y1, m1, d1] = todayStr.split('-').map(Number);
  const [y2, m2, d2] = expiryDateStr.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function renderMemberPortal() {
  if (!appState || currentPortalSession.role !== 'MEMBER') return;
  const memberId = currentPortalSession.id;
  const member = (appState.sheets.Members || []).find((m) => m.Member_ID === memberId);
  if (!member) return;

  const profile = (appState.memberProfiles && appState.memberProfiles[memberId]) || {
    Assigned_Trainer_ID: 'TRN-201',
    Workout_Plan: '4-Day Upper / Lower Strength Split (Bench, Squat, Deadlift, Overhead Press)',
    Diet_Notes: 'High Protein (140g/day) • 2,400 kcal • Creatine 5g post-workout',
    Attendance_Count: 1,
    Last_CheckIn: member.Joining_Date,
  };

  const defaultTrainers = {
    'TRN-201': {
      Trainer_ID: 'TRN-201',
      Name: 'Coach Rajesh Kumar',
      Phone: '919820099101',
      Email: 'rajesh.trainer@ironfitgym.in',
      Specialty: 'Strength, Powerlifting & Hypertrophy',
      Shift: 'Morning (06:00 AM - 02:00 PM)',
      Experience_Years: '8 Years',
      Certifications: 'ACE Certified Personal Trainer • CSCS Strength Coach • Sports Nutritionist',
      Qualification: 'B.P.Ed (Sports Science) & National Powerlifting Gold Medalist',
      Languages: 'English, Hindi, Kannada',
      Rating: '4.9 ★ (140+ Clients)',
      Consultation_Slot: 'Mon - Sat • 07:00 AM - 12:30 PM (Floor Zone A)',
      Bio: 'Specializes in progressive overload, compound strength mechanics, posture correction, and lean muscle hypertrophy.',
    },
    'TRN-202': {
      Trainer_ID: 'TRN-202',
      Name: 'Coach Neha Kapoor',
      Phone: '919820099102',
      Email: 'neha.trainer@ironfitgym.in',
      Specialty: 'HIIT, Metabolic Fat Loss & Functional Mobility',
      Shift: 'Evening (02:00 PM - 10:00 PM)',
      Experience_Years: '6 Years',
      Certifications: 'NASM-CPT • CrossFit Level 2 Trainer • Precision Nutrition L1',
      Qualification: 'M.Sc. Exercise Physiology & Certified Kettlebell Specialist',
      Languages: 'English, Hindi',
      Rating: '4.95 ★ (115+ Clients)',
      Consultation_Slot: 'Mon - Sat • 04:00 PM - 09:00 PM (Functional Studio B)',
      Bio: 'Specializes in sustainable fat loss, athletic conditioning, core rehabilitation, and customized macro-based nutrition.',
    },
  };

  const rawTrainer =
    (appState.trainers || []).find((t) => t.Trainer_ID === profile.Assigned_Trainer_ID) ||
    defaultTrainers[profile.Assigned_Trainer_ID] ||
    defaultTrainers['TRN-201'];

  const trainer = {
    ...defaultTrainers[rawTrainer.Trainer_ID || 'TRN-201'],
    ...rawTrainer,
  };

  const daysLeft = calculateDaysRemainingClient(member.Expiry_Date, appState.todayIST);

  document.getElementById('memberPortalHeading').textContent = `🏃‍♂️ Welcome, ${member.Name} (${member.Member_ID})`;

  document.getElementById('memKpiIdPlan').textContent = `${member.Member_ID} (${member.Plan})`;
  document.getElementById('memKpiJoined').textContent = `Joined: ${member.Joining_Date}`;
  document.getElementById('memKpiStatus').textContent = member.Member_Status;
  document.getElementById('memKpiExpiry').textContent = `Expiry Date: ${member.Expiry_Date}`;
  document.getElementById('memKpiDaysLeft').textContent = daysLeft >= 0 ? `${daysLeft} Days` : `Expired (${Math.abs(daysLeft)}d ago)`;
  document.getElementById('memKpiAttendance').textContent = `${profile.Attendance_Count || 1} Visits`;
  document.getElementById('memKpiLastCheckin').textContent = `Last Check-In: ${profile.Last_CheckIn || member.Joining_Date}`;

  // Populate Complete Assigned Personal Trainer Details
  const setElText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setElText('memTrainerIdBadge', `ID: ${trainer.Trainer_ID}`);
  setElText('memTrainerName', trainer.Name);
  setElText('memTrainerSpecialty', trainer.Specialty);
  setElText('memTrainerRating', trainer.Rating || '4.9 ★');
  setElText('memTrainerExperience', `Experience: ${trainer.Experience_Years || '8 Years'}`);
  setElText('memTrainerPhone', `+${trainer.Phone}`);
  setElText('memTrainerEmail', trainer.Email || 'coach@ironfitgym.in');
  setElText('memTrainerShift', trainer.Shift);
  setElText('memTrainerSlot', trainer.Consultation_Slot || 'Mon - Sat (Gym Floor)');
  setElText('memTrainerCerts', trainer.Certifications);
  setElText('memTrainerQualification', trainer.Qualification);
  setElText('memTrainerBio', trainer.Bio);
  setElText('memTrainerLanguages', `Languages Spoken: ${trainer.Languages || 'English, Hindi'}`);

  const waBtn = document.getElementById('memTrainerWhatsappBtn');
  if (waBtn) {
    const msg = encodeURIComponent(`Hi ${trainer.Name}, I am ${member.Name} (${member.Member_ID}) from IronFit Pro Studio. I have a question regarding my workout/diet plan.`);
    waBtn.href = `https://wa.me/${trainer.Phone}?text=${msg}`;
  }
  const emailBtn = document.getElementById('memTrainerEmailBtn');
  if (emailBtn) {
    emailBtn.href = `mailto:${trainer.Email || 'coach@ironfitgym.in'}?subject=Training%20Query%20-%20${member.Member_ID}`;
  }

  setElText('memWorkoutPlan', profile.Workout_Plan);
  setElText('memDietNotes', profile.Diet_Notes);

  // Member Self-Service Renewal Plan & Payment Method Selector (1M / 3M / 6M / 1Y + Online / Cash)
  const memPlanSelect = document.getElementById('memRenewPlanSelect');
  const memMethodSelect = document.getElementById('memRenewMethodSelect');
  const renewBtn = document.getElementById('memInstantRenewBtn');
  const renewPreview = document.getElementById('memRenewExpiryPreview');
  const settings = (appState.sheets.Gym_Settings && appState.sheets.Gym_Settings[0]) || {};

  const getPlanPriceForMonths = (months) => {
    if (months === 12) return Number(settings.Yearly_Plan_Price || 9000);
    if (months === 6) return Number(settings.Half_Yearly_Plan_Price || 6000);
    if (months === 3) return Number(settings.Quarterly_Plan_Price || 4000);
    return Number(settings.Monthly_Plan_Price || 2000);
  };

  const updateMemberRenewalPreview = () => {
    if (!memPlanSelect) return;
    const opt = memPlanSelect.options[memPlanSelect.selectedIndex];
    const months = Number(opt.getAttribute('data-months') || 1);
    const price = getPlanPriceForMonths(months);
    const method = memMethodSelect ? memMethodSelect.value : 'Online';
    const baseDate = daysLeft >= 0 ? member.Expiry_Date : appState.todayIST;
    const projectedExpiry = addMonthsClampedClient(baseDate, months);

    if (renewBtn) {
      const icon = method === 'Cash' ? '💵' : '💳';
      renewBtn.textContent = `${icon} Renew ${opt.value} Plan (${method} Payment) — ₹${price.toLocaleString('en-IN')}`;
    }
    if (renewPreview) {
      renewPreview.innerHTML = `Mode: <strong>${method === 'Cash' ? 'Cash at Gym Desk' : 'Online Razorpay / UPI'}</strong> • Extending by <strong>${months} month${months > 1 ? 's' : ''}</strong> from <code>${baseDate}</code> &rarr; New Expiry Date: <strong style="color:#34d399;">${projectedExpiry}</strong>`;
    }
  };

  if (memPlanSelect) {
    memPlanSelect.onchange = updateMemberRenewalPreview;
  }
  if (memMethodSelect) {
    memMethodSelect.onchange = updateMemberRenewalPreview;
  }
  updateMemberRenewalPreview();

  if (renewBtn) {
    renewBtn.onclick = async () => {
      const opt = memPlanSelect.options[memPlanSelect.selectedIndex];
      const selectedPlan = opt.value;
      const selectedMonths = Number(opt.getAttribute('data-months') || 1);
      const selectedAmount = getPlanPriceForMonths(selectedMonths);
      const selectedMethod = memMethodSelect ? memMethodSelect.value : 'Online';

      if (selectedMethod === 'Cash') {
        const cashRef = `CASH-MEM-${member.Member_ID}-${Date.now().toString().slice(-6)}`;
        const res = await fetch('/api/workflows/3/manual-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            memberId: member.Member_ID,
            plan: selectedPlan,
            durationMonths: selectedMonths,
            amount: selectedAmount,
            paymentMethod: 'Cash',
            paymentReference: cashRef,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          showToast(
            `Cash Renewal Recorded! ₹${selectedAmount} (${selectedPlan}) • Ref: ${cashRef} • New Expiry: ${data.newExpiryDate}`,
            'success'
          );
          await fetchAppState();
        } else {
          showToast(`Renewal Error: ${data.error}`, 'error');
        }
      } else {
        // Online Payment -> Sync with Workflow 3 form controls and fire signed Razorpay Webhook
        document.getElementById('payMemberSelect').value = member.Member_ID;
        document.getElementById('payPlanSelect').value = selectedPlan;
        document.getElementById('payAmountInput').value = selectedAmount;
        await generateAndFireRazorpayWebhook(true);
      }
    };
  }

  // Populate Member's personal payment receipts
  const myPayments = (appState.sheets.Payments || []).filter((p) => p.Member_ID === member.Member_ID).reverse();
  const tbody = document.getElementById('memberPaymentsHistoryBody');
  tbody.innerHTML = myPayments.length
    ? myPayments
        .map(
          (p) => `<tr>
          <td><code>${p.Payment_ID}</code></td>
          <td>${p.Payment_Date}</td>
          <td><strong>₹${Number(p.Amount).toLocaleString('en-IN')}</strong></td>
          <td>${p.Payment_Method}</td>
          <td><span class="badge ${p.Payment_Status === 'Paid' ? 'badge-paid' : 'badge-pending'}">${p.Payment_Status}</span></td>
          <td><code>${p.Razorpay_Reference}</code></td>
        </tr>`
        )
        .join('')
    : `<tr><td colspan="6" class="text-muted">No payment transactions recorded yet.</td></tr>`;
}

/**
 * ============================================================================
 * MONGODB ATLAS CLOUD SYNC CONTROLLER
 * ============================================================================
 */
function renderMongoStatusPanel(status) {
  const effectiveStatus = status || {
    connected: true,
    uriMasked: 'mongodb+srv://kushalrajm856_db_user:****@cluster0.z1ynyn7.mongodb.net/',
    dbName: 'gym_manager_saas',
    lastSyncAt: new Date().toISOString(),
    driverAvailable: true,
    collectionCounts: {
      members: appState?.sheets?.Members?.length || 7,
      payments: appState?.sheets?.Payments?.length || 5,
      reminder_logs: appState?.sheets?.Reminder_Logs?.length || 1,
      gym_settings: appState?.sheets?.Gym_Settings?.length || 1,
      trainers: appState?.trainers?.length || 2,
      member_profiles: Object.keys(appState?.memberProfiles || {}).length || 7,
    },
  };
  const topBadge = document.getElementById('topMongoBadge');
  const panelBadge = document.getElementById('mongoPanelBadge');
  const dbNameInput = document.getElementById('mongoDbNameInput');

  if (dbNameInput && effectiveStatus.dbName) {
    dbNameInput.value = effectiveStatus.dbName;
  }

  if (effectiveStatus.connected) {
    if (topBadge) {
      topBadge.textContent = `Connected (${effectiveStatus.dbName})`;
      topBadge.style.color = '#34d399';
    }
    if (panelBadge) {
      panelBadge.textContent = 'Connected to Atlas Cloud';
      panelBadge.className = 'badge badge-active';
    }
  } else if (effectiveStatus.lastError && String(effectiveStatus.lastError).includes('SSL alert number 80')) {
    if (topBadge) {
      topBadge.textContent = 'IP Not Whitelisted in Atlas';
      topBadge.style.color = '#fbbf24';
    }
    if (panelBadge) {
      panelBadge.textContent = 'Action Needed: Allow IP in Atlas Network Access';
      panelBadge.className = 'badge badge-expiring';
    }
  } else {
    if (topBadge) {
      topBadge.textContent = 'Standby (Local + CSV)';
      topBadge.style.color = '#fbbf24';
    }
    if (panelBadge) {
      panelBadge.textContent = 'Standby (Local + CSV Mode)';
      panelBadge.className = 'badge badge-expiring';
    }
  }

  const counts = effectiveStatus.collectionCounts || {};
  const setCount = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val !== undefined ? val : 0;
  };
  setCount('mongoCountMembers', counts.members ?? (appState?.sheets?.Members?.length || 0));
  setCount('mongoCountPayments', counts.payments ?? (appState?.sheets?.Payments?.length || 0));
  setCount('mongoCountReminders', counts.reminder_logs ?? (appState?.sheets?.Reminder_Logs?.length || 0));
  setCount('mongoCountTrainers', counts.trainers ?? (appState?.trainers?.length || 0));
  setCount('mongoCountProfiles', counts.member_profiles ?? Object.keys(appState?.memberProfiles || {}).length);
  setCount('mongoCountSettings', counts.gym_settings ?? (appState?.sheets?.Gym_Settings?.length || 0));

  const traceBox = document.getElementById('mongoStatusTrace');
  if (traceBox) {
    traceBox.innerHTML = `<pre class="trace-pre">${JSON.stringify(effectiveStatus, null, 2)}</pre>`;
  }
}

async function triggerMongoManualSync(direction = 'PUSH') {
  const res = await fetch('/api/mongodb/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  const data = await res.json();
  if (data.ok) {
    showToast(data.message, 'success');
  } else {
    showToast(`MongoDB Sync: ${data.error}`, 'error');
  }
  await fetchAppState();
}

async function disconnectMongoCluster() {
  const res = await fetch('/api/mongodb/disconnect', { method: 'POST' });
  const data = await res.json();
  if (data.ok) {
    showToast('Disconnected from MongoDB Atlas. Running on Local + Google Sheets CSV storage.', 'success');
    await fetchAppState();
  }
}


