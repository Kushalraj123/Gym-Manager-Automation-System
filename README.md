# Gym Manager Automation System — Full-Stack Engineering & SaaS Handover Guide

This guide walks you step-by-step through building, configuring, testing, and selling the **Gym Manager Automation System** powered by **n8n**, **Google Sheets**, **WhatsApp Business Cloud API**, **Razorpay**, **Gmail**, and the **Full-Stack Gym Owner Web Portal**.

---

## Quick Start: Run the Full-Stack Application Locally

Your workspace includes a complete, zero-dependency Node.js Full-Stack Server & n8n Workflow Simulator so you can demonstrate the entire system to gym owners right away:

```bash
# 1. Run the automated end-to-end verification suite (all 4 workflows + edge cases)
npm test

# 2. Start the Full-Stack Gym Owner Portal & API Server on http://localhost:3000
npm start
```

---

## Step 1: Complete System Architecture

```
+-----------------------------------------------------------------------------------+
|                        GYM OWNER & MEMBER TOUCHPOINTS                             |
|  1. Web Portal / Google Form (Member Registration & Manual Cash/UPI Entry)        |
|  2. Razorpay Payment Links (Online UPI / Card / NetBanking Renewals)              |
+--------------------+-----------------------------------------+--------------------+
                     |                                         |
                     v (POST Webhook)                          v (POST Webhook + x-razorpay-signature)
+-----------------------------------------------------------------------------------+
|                     n8n AUTOMATION ENGINE (Timezone: Asia/Kolkata)                |
|                                                                                   |
|  [Workflow 1: Member Registration]                                                |
|   Form Trigger -> Validate & Normalize Phone (91XXXXXXXXXX) -> Check Duplicate    |
|   -> Calculate Month-End Safe Expiry -> Append to Google Sheets -> Welcome WA     |
|                                                                                   |
|  [Workflow 2: Membership Expiry Reminder] (Cron: 08:00 AM IST Daily)              |
|   Schedule Trigger -> Read Members -> Filter (3 Days & Today) -> Check Consent    |
|   -> Check Reminder_Logs (Idempotency) -> Send Approved WA Template -> Save Log   |
|                                                                                   |
|  [Workflow 3: Payment Processing]                                                 |
|   Razorpay Webhook / Manual Form -> Verify Raw Body HMAC-SHA256 Signature         |
|   -> Check Duplicate Reference (Idempotency) -> Find Member -> Update Payment     |
|   -> Extend Membership Expiry -> Save Transaction History -> Send WA Receipt      |
|                                                                                   |
|  [Workflow 4: Daily Gym Report] (Cron: 08:30 AM IST Daily)                        |
|   Schedule Trigger -> Read Members & Payments -> Compute 8 Core KPIs              |
|   -> Generate Clean Executive HTML Report -> Send Email via Gmail to Owner        |
+--------------------+-----------------------------------------+--------------------+
                     |                                         |
                     v                                         v
+----------------------------------------+   +--------------------------------------+
|   GOOGLE SHEETS 4-TAB DATABASE         |   |   EXTERNAL CLOUD INTEGRATIONS        |
|   - Sheet 1: Members                   |   |   - Meta WhatsApp Cloud API (v20.0)  |
|   - Sheet 2: Payments                  |   |   - Razorpay Payment Gateway         |
|   - Sheet 3: Reminder_Logs             |   |   - Gmail OAuth2 (Owner Reports)     |
|   - Sheet 4: Gym_Settings              |   |                                      |
+----------------------------------------+   +--------------------------------------+
```

---

## Step 2: Google Sheets 4-Tab Database Structure

Ready-to-import CSV templates are generated automatically in `database/sheets/`:
- `database/sheets/Members.csv`
- `database/sheets/Payments.csv`
- `database/sheets/Reminder_Logs.csv`
- `database/sheets/Gym_Settings.csv`

### Sheet 1: `Members`
| Column Name | Format / Example | Purpose |
| :--- | :--- | :--- |
| `Member_ID` | `GYM-1001` | Unique auto-generated member identifier |
| `Name` | `Aarav Sharma` | Full name of the gym member |
| `Phone` | `919876543210` | Normalized 12-digit E.164 Indian number (Primary deduplication key) |
| `Email` | `aarav@example.in` | Optional email address |
| `Plan` | `Monthly` / `Quarterly` / `Yearly` | Selected membership plan |
| `Joining_Date` | `YYYY-MM-DD` | Membership start date in IST |
| `Expiry_Date` | `YYYY-MM-DD` | Automatically calculated with month-end clamping |
| `Payment_Status` | `Paid` / `Pending` | Current fee payment status |
| `Payment_Method` | `UPI` / `Cash` / `Razorpay` | Mode of payment |
| `WhatsApp_Consent` | `TRUE` / `FALSE` | Explicit opt-in required before sending WhatsApp messages |
| `Last_Reminder_Date` | `YYYY-MM-DD` | Prevents duplicate reminders on the same day |
| `Member_Status` | `Active` / `Expiring Soon` / `Expired` | Computed lifecycle status |

### Sheet 2: `Payments`
| Column Name | Format / Example | Purpose |
| :--- | :--- | :--- |
| `Payment_ID` | `PAY-5001` | Unique transaction ID |
| `Member_ID` | `GYM-1001` | Foreign key linking to `Members` |
| `Amount` | `1500` | Amount in INR (₹) |
| `Payment_Method` | `Razorpay` / `UPI` / `Cash` | Channel used |
| `Payment_Status` | `Paid` / `Pending` | Settlement state |
| `Payment_Date` | `YYYY-MM-DD` | Date recorded in `Asia/Kolkata` |
| `Razorpay_Reference` | `pay_RzpSeedRef1001` | Unique Razorpay payment ID or UPI UTR / Cash receipt number (Idempotency key) |
| `Webhook_Processed` | `TRUE` / `FALSE` | Marks whether expiry extension has been applied |

### Sheet 3: `Reminder_Logs`
| Column Name | Format / Example | Purpose |
| :--- | :--- | :--- |
| `Reminder_ID` | `REM-9001` | Unique log entry ID |
| `Member_ID` | `GYM-1002` | Member notified |
| `Phone` | `919876543211` | Recipient WhatsApp number |
| `Reminder_Type` | `3DAY_EXPIRY` / `TODAY_EXPIRY` | Template category dispatched |
| `Sent_Date` | `YYYY-MM-DD` | Date sent (used for same-day deduplication) |
| `Delivery_Status` | `SENT (wamid.HBgM...)` | Meta WhatsApp message ID (`wamid`) |

### Sheet 4: `Gym_Settings`
| Column Name | Format / Example | Purpose |
| :--- | :--- | :--- |
| `Gym_Name` | `IronFit Pro Fitness Studio` | Used in WhatsApp messages & Daily HTML Reports |
| `Owner_Email` | `owner@ironfitgym.in` | Recipient for Workflow 4 Daily Report |
| `WhatsApp_Number` | `919820011223` | Gym's WhatsApp Business number |
| `Monthly_Plan_Price` | `1500` | Default 1-month fee (₹) |
| `Quarterly_Plan_Price` | `4000` | Default 3-month fee (₹) |
| `Yearly_Plan_Price` | `14000` | Default 12-month fee (₹) |
| `Reminder_Time` | `08:00` | Scheduled morning reminder time (IST) |

---

## Step 3–8: Node-by-Node Breakdown of All 4 n8n Workflows

Importable n8n JSON files are located in `n8n-workflows/`:
1. `n8n-workflows/workflow-1-member-registration.json`
2. `n8n-workflows/workflow-2-expiry-reminders.json`
3. `n8n-workflows/workflow-3-payment-processing.json`
4. `n8n-workflows/workflow-4-daily-report.json`

### Workflow 1: New Member Registration
- **Node 1 (`1. Form Trigger (Webhook)`)** — `n8n-nodes-base.webhook`: Receives `POST /webhook/gym-register-member`.
- **Node 2 (`2. Validate, Normalize Phone & Calculate Expiry`)** — `n8n-nodes-base.code`:
  - Validates required fields (`Name`, `Phone`, `Joining_Date`).
  - Strips spaces/dashes/`+91`/`0` and validates Indian mobile format (`/^[6-9]\d{9}$/`), normalizing to `91XXXXXXXXXX`.
  - Calculates `Expiry_Date` using `addMonthsClamped(joiningDate, durationMonths)` so **January 31 + 1 month = February 28** (or **February 29** in a leap year).
- **Node 3 (`3. Lookup Phone in Google Sheets`)** — `n8n-nodes-base.googleSheets` (`alwaysOutputData: true`): Searches `Members` tab where `Phone == $json.Phone`.
- **Node 4 (`4. IF Phone Not Registered`)** — `n8n-nodes-base.if`: Branches `TRUE` if `Member_ID` is empty; branches `FALSE` to **Node 7 (`Respond 409 Duplicate Member`)** if the phone number already exists.
- **Node 5 (`5. Add Member to Google Sheets`)** — `n8n-nodes-base.googleSheets`: Appends the validated row to `Sheet 1: Members`.
- **Node 6 (`6. Send Welcome WhatsApp Message`)** — `n8n-nodes-base.httpRequest`: Calls `https://graph.facebook.com/v20.0/{{ $env.WHATSAPP_PHONE_NUMBER_ID }}/messages` with template `gym_welcome_member_v1`.

### Workflow 2: Membership Expiry Reminder
- **Node 1 (`1. Schedule Trigger`)** — `n8n-nodes-base.scheduleTrigger`: Cron `0 8 * * *` (`08:00 AM` in `Asia/Kolkata`).
- **Node 2 (`2. Read Members`)** — `n8n-nodes-base.googleSheets`: Reads all rows from `Sheet 1: Members`.
- **Node 3 (`3. Calculate Remaining Days, Check Consent & Deduplicate`)** — `n8n-nodes-base.code`:
  - Computes `daysRemaining` in `Asia/Kolkata` timezone.
  - Filters only `daysRemaining === 3` (`3DAY_EXPIRY`) or `daysRemaining === 0` (`TODAY_EXPIRY`).
  - Checks `WhatsApp_Consent === "TRUE"` and verifies `Last_Reminder_Date !== todayIST` to prevent duplicate reminders on the same day.
- **Node 4 (`4. Send Approved WhatsApp Template`)** — `n8n-nodes-base.httpRequest`: Dispatches `gym_expiry_3day_reminder` or `gym_expiry_today_reminder`.
- **Node 5 (`5. Save Reminder Log`)** — `n8n-nodes-base.googleSheets`: Appends audit record to `Sheet 3: Reminder_Logs`.
- **Node 6 (`6. Update Member Last_Reminder_Date`)** — `n8n-nodes-base.googleSheets`: Updates `Last_Reminder_Date = todayIST` on `Sheet 1: Members`.

### Workflow 3: Payment Processing (Razorpay Webhook & Manual Cash/UPI)
- **Node 1 (`1. Razorpay Webhook / Manual Payment Trigger`)** — `n8n-nodes-base.webhook` (`rawBody: true`): Receives Razorpay `payment_link.paid` / `payment.captured` webhooks or manual Cash/UPI form posts.
- **Node 2 (`2. Verify HMAC-SHA256 Signature & Normalize`)** — `n8n-nodes-base.code`:
  - Computes `crypto.createHmac('sha256', $env.RAZORPAY_WEBHOOK_SECRET).update(rawBody, 'utf8').digest('hex')` and uses `crypto.timingSafeEqual` against `headers['x-razorpay-signature']`.
  - Rejects any unverified webhook or browser redirect immediately.
- **Node 3 & 4 (`3. Check Duplicate Payment Reference` + `4. IF Reference Not Already Processed`)**: Looks up `Razorpay_Reference` in `Sheet 2: Payments`. If already processed, exits idempotently without extending membership twice.
- **Node 5 & 6 (`5. Find Member` + `6. Calculate Extended Membership Expiry`)**: If the member's current `Expiry_Date >= todayIST`, extends from `Expiry_Date`; if already expired, extends from `todayIST`.
- **Node 7, 8 & 9**: Updates `Sheet 1: Members`, appends transaction to `Sheet 2: Payments`, and sends WhatsApp payment receipt.

### Workflow 4: Daily Gym Report
- **Node 1 (`1. Schedule Trigger`)** — Cron `30 8 * * *` (`08:30 AM` IST).
- **Node 2 & 3 (`Read Members` & `Read Payments`)** — Reads `Sheet 1` and `Sheet 2`.
- **Node 4 (`4. Calculate Statistics & Generate HTML Report`)** — Computes all 8 required daily metrics (`totalRegistered`, `currentlyActive`, `expiredMemberships`, `expiringToday`, `expiringIn3Days`, `pendingPayments`, `paymentsReceivedToday`, `totalRevenueToday`) and renders an HTML email report.
- **Node 5 (`5. Send Email Report to Gym Owner`)** — `n8n-nodes-base.gmail`: Sends the HTML briefing to `Owner_Email`.

---

## Step 9: WhatsApp Business Cloud API Setup & Template Approval

1. **Create a Meta Developer App:**
   - Go to [developers.facebook.com](https://developers.facebook.com/) → Create App → Select **Business** → Add **WhatsApp** product.
2. **Generate a Permanent System User Access Token:**
   - In **Meta Business Settings → Users → System Users**, create an Admin System User.
   - Assign the Gym's WhatsApp Business Account with `whatsapp_business_messaging` and `whatsapp_business_management` permissions.
   - Copy the Permanent Token into `WHATSAPP_ACCESS_TOKEN` and the Phone Number ID into `WHATSAPP_PHONE_NUMBER_ID`.
3. **Submit WhatsApp Templates for Approval (Category: `UTILITY`, Language: `en`):**
   - **Template 1 (`gym_expiry_3day_reminder`):**
     `Hello {{1}}, your gym membership expires in 3 days. Please renew your membership to continue enjoying our facilities. Thank you!`
   - **Template 2 (`gym_expiry_today_reminder`):**
     `Hello {{1}}, your gym membership expires today. Please renew your plan to continue your fitness journey!`
   - **Template 3 (`gym_welcome_member_v1`):**
     `Welcome to our gym, {{1}}! Your membership ({{2}}) is active until {{3}}. Thank you!`
   - **Template 4 (`gym_payment_receipt_v1`):**
     `Hello {{1}}, we have received your payment of {{2}}. Your gym membership is now extended until {{3}}. Thank you!`

---

## Step 10: Razorpay Webhook Configuration

1. Log in to **Razorpay Dashboard → Account & Settings → Webhooks → + Add New Webhook**.
2. **Webhook URL:** `https://your-n8n-domain.com/webhook/gym-payment-webhook`
3. **Secret:** Set a strong secret (e.g. `gym_rzp_whsec_9f8e7d6c5b4a3f2e1d0c`) and store it in n8n environment variable `RAZORPAY_WEBHOOK_SECRET`.
4. **Active Events:** Check `payment_link.paid` and `payment.captured`.
5. **Metadata (`notes`) on Payment Links:** Always include `notes.member_id`, `notes.plan`, and `notes.duration_months` when generating a payment link so Workflow 3 automatically maps the webhook back to the exact `Member_ID`.

---

## Step 13: Commercial SaaS Business Model & Client Handover Checklist

### Multi-Gym Isolation Strategy
- **Separate Data Ownership:** Each gym client uses their own Google Account (hosting their 4-tab Google Sheet) and their own Meta WhatsApp Business Account.
- **Zero Hardcoding:** All 4 n8n workflows reference `GOOGLE_SHEETS_SPREADSHEET_ID`, `WHATSAPP_PHONE_NUMBER_ID`, `RAZORPAY_WEBHOOK_SECRET`, and `GMAIL_OWNER_EMAIL` via environment variables / n8n credentials.

### Estimated Monthly Operating Costs (Per Gym)
| Component | Monthly Cost (INR) | Notes |
| :--- | :--- | :--- |
| **n8n Hosting** (Hetzner / DigitalOcean VPS) | ₹400 – ₹600 / mo | 1 VPS (₹600/mo) can easily host 10–15 local gyms |
| **Google Sheets & Gmail API** | ₹0 | Included in free Google Account / Workspace |
| **Meta WhatsApp Cloud API (Utility Messages)** | ~₹150 – ₹300 / mo | Utility template messages in India cost ~₹0.12–₹0.15 per message |
| **Razorpay Gateway Fee** | 2% per online txn | Only on online links; ₹0 for Cash / direct UPI entries |
| **Total Monthly Infrastructure Cost** | **~₹550 – ₹900 / mo** | High gross margin for your automation agency |

### Suggested Commercial Pricing
- **One-Time Setup & Onboarding Fee:** **₹10,000 – ₹15,000 per gym** (Initial example setup fee covering Google Sheet database setup, Meta WhatsApp Cloud API verification & template approvals, Razorpay webhook integration, and front-desk training).
- **Optional Monthly Maintenance Retainer (AMC):** **₹1,500 – ₹2,500 / month** (Covers managed n8n hosting, daily workflow health monitoring, sheet backups, and template updates).

### Client Handover Checklist
- [ ] Clone the 4 CSV files (`Members`, `Payments`, `Reminder_Logs`, `Gym_Settings`) into the client's Google Sheet.
- [ ] Update `Sheet 4: Gym_Settings` with the gym's name, owner email, WhatsApp number, and plan prices.
- [ ] Connect the client's Google OAuth2 credential in n8n and set `GOOGLE_SHEETS_SPREADSHEET_ID`.
- [ ] Verify all 4 WhatsApp Utility Templates show **Approved (Green)** in Meta WhatsApp Manager.
- [ ] Configure Razorpay Webhook URL & `RAZORPAY_WEBHOOK_SECRET`, then run a ₹1 test payment.
- [ ] Walk the gym owner through registering a member, recording a Cash/UPI payment, and checking the 08:30 AM Daily Email Report.
