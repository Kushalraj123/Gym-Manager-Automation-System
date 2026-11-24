# 🏋️‍♂️ IronFit Pro — Gym Manager Automation System (Full-Stack SaaS + n8n + MongoDB Atlas)

[![Live Demo on Vercel](https://img.shields.io/badge/Live_Demo-Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://gym-manager-system-hazel.vercel.app)
[![Node.js](https://img.shields.io/badge/Node.js-v18%2B_%2F_v22%2B-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MongoDB Atlas](https://img.shields.io/badge/MongoDB_Atlas-Cloud_Sync-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://www.mongodb.com/atlas)
[![n8n Workflows](https://img.shields.io/badge/n8n-4_Automated_Workflows-EA4B71?style=for-the-badge&logo=n8n&logoColor=white)](https://n8n.io/)
[![Razorpay](https://img.shields.io/badge/Razorpay_%26_UPI_QR-HMAC--SHA256-02042B?style=for-the-badge&logo=razorpay&logoColor=3395FF)](https://razorpay.com/)

A production-ready **Gym Manager Automation System & Commercial Multi-Gym SaaS** built for local fitness centers. It combines a **Role-Based Full-Stack Web Portal (Gym Owner, Trainer & Member Self-Service)** with **4 automated n8n workflows**, **MongoDB Atlas Cloud persistence**, **4-Tab Google Sheets two-way sync**, **Meta WhatsApp Business Cloud API renewal reminders**, **Razorpay HMAC-SHA256 webhook verification + PhonePe/UPI QR Checkout**, and **Automated Daily Executive HTML Email Reports**.

🔗 **Live Production App:** [https://gym-manager-system-hazel.vercel.app](https://gym-manager-system-hazel.vercel.app)

---

## ✨ Key Highlights & Features

### 1. 🔐 Multi-Role Full-Screen Authentication & Dedicated Portals
- **👑 Gym Owner / Admin Command Center** (`owner@ironfitgym.in` | PIN: `1234`)
  - Real-time KPI dashboard (Total Registered, Currently Active, Expiring Today / 3 Days, Expired, Revenue Today, Pending Payments).
  - Full control over all 4 n8n workflows, live node execution trace inspector, 4-Tab Google Sheets viewer & CSV downloader, MongoDB Atlas two-way cloud sync console, and tenant settings.
- **🏋️‍♂️ Gym Trainer Portal** (`TRN-201` Coach Rajesh Kumar / `TRN-202` Coach Neha Kapoor | PIN: `1234`)
  - View assigned trainees, filter by expiring memberships, customize **Workout Splits** & **Nutrition/Diet Guidelines**, assign coaches, and log **`+1 Mark Today's Check-In`**.
- **🏃‍♂️ Gym Member Self-Service Portal** (`GYM-1001`, `GYM-1002`, `GYM-1004` or registered phone | PIN: `1234`)
  - Live membership expiry countdown (`Asia/Kolkata` IST), total gym check-ins, and personal payment receipt history.
  - **Assigned Personal Trainer — Complete Profile Card:** Displays the member's head coach credentials, specialty, rating, experience, shift timings, floor consultation slot, certifications (`ACE`, `CSCS`, `NASM-CPT`, `CrossFit L2`), coaching bio, and 1-click **WhatsApp / Email Coach** buttons.
  - **Self-Service Plan Renewal (`1 Month`, `3 Months`, `6 Months`, `1 Year`):** Choose between **Online Payment** (navigates to a dedicated **PhonePe / UPI QR Code Checkout Page**) or **Cash Payment at Gym Desk** with instant expiry date extension.

---

### 2. 💰 Standardized Gym Membership Plans
| Plan Name | Duration | Standard Fee (INR) | Expiry Calculation |
| :--- | :---: | :---: | :--- |
| **Monthly Plan** | `1 Month` | **₹2,000** | Month-end clamped (`addMonthsClamped`) |
| **Quarterly Plan** | `3 Months` | **₹4,000** | Month-end clamped (`+3 Months`) |
| **Half-Yearly Plan** | `6 Months` | **₹6,000** | Month-end clamped (`+6 Months`) |
| **Yearly Plan** | `1 Year (12 Months)` | **₹9,000** | Month-end clamped (`+12 Months`) |

---

### 3. 🍃 Hybrid Cloud Database: MongoDB Atlas + Google Sheets 4-Tab Sync
Every registration, payment webhook, WhatsApp reminder, and trainer workout update writes through in real time to **7 MongoDB Atlas collections** (`gym_manager_saas`) and **4 Google Sheets CSV tabs**:

#### MongoDB Atlas Collections (`gym_manager_saas`)
1. `members` *(Unique indexes on `Member_ID` and `Phone`)*
2. `payments` *(Unique index on `Payment_ID`, indexed on `Razorpay_Reference`)*
3. `reminder_logs` *(Unique index on `Reminder_ID`)*
4. `gym_settings` *(Multi-tenant gym configuration & pricing)*
5. `trainers` *(Coach credentials, certifications, shifts & ratings)*
6. `member_profiles` *(Assigned trainers, workout routines, diet notes & check-in counts)*
7. `execution_audit_logs` *(Complete n8n workflow execution audit trail)*

#### Google Sheets 4-Tab Database Structure (`database/sheets/*.csv`)
- **Sheet 1 (`Members`):** `Member_ID | Name | Phone | Email | Plan | Joining_Date | Expiry_Date | Payment_Status | Payment_Method | WhatsApp_Consent | Last_Reminder_Date | Member_Status`
- **Sheet 2 (`Payments`):** `Payment_ID | Member_ID | Amount | Payment_Method | Payment_Status | Payment_Date | Razorpay_Reference | Webhook_Processed`
- **Sheet 3 (`Reminder_Logs`):** `Reminder_ID | Member_ID | Phone | Reminder_Type | Sent_Date | Delivery_Status`
- **Sheet 4 (`Gym_Settings`):** `Gym_Name | Owner_Email | WhatsApp_Number | Monthly_Plan_Price | Quarterly_Plan_Price | Half_Yearly_Plan_Price | Yearly_Plan_Price | Reminder_Time`

---

## ⚡ 4 Production n8n Workflows (`n8n-workflows/*.json`)

Importable n8n workflow JSON blueprints are included in `/n8n-workflows`:

1. **Workflow 1: New Member Registration** (`workflow-1-member-registration.json`)
   - `Form Trigger` &rarr; `Validate Input` &rarr; `Normalize Indian Phone (91XXXXXXXXXX)` &rarr; `Check Duplicate Phone (409 Guard)` &rarr; `Calculate Month-End Safe Expiry (Jan 31 + 1M = Feb 28/29)` &rarr; `Append to Google Sheets / MongoDB Atlas` &rarr; `Send Welcome WhatsApp Template`.
2. **Workflow 2: Automated Membership Expiry Reminders** (`workflow-2-expiry-reminders.json`)
   - `Schedule Trigger (08:00 AM IST)` &rarr; `Read Members` &rarr; `Calculate Remaining Days` &rarr; `Filter Expiring in 3 Days (3DAY_EXPIRY) & Today (TODAY_EXPIRY)` &rarr; `Verify WhatsApp_Consent === TRUE` &rarr; `Check Reminder_Logs (Same-Day Idempotency)` &rarr; `Send Approved Meta WhatsApp Template` &rarr; `Save Reminder Log`.
3. **Workflow 3: Payment Processing — Razorpay Webhook, UPI QR & Manual Cash/UPI** (`workflow-3-payment-processing.json`)
   - `Razorpay Webhook / Manual Form Trigger` &rarr; `Verify Cryptographic Raw-Body HMAC-SHA256 Signature` &rarr; `Check Duplicate Razorpay_Reference (409 Idempotency Guard)` &rarr; `Find Member` &rarr; `Update Payment Status` &rarr; `Extend Membership Expiry Date` &rarr; `Save Transaction History` &rarr; `Notify Member via WhatsApp`.
4. **Workflow 4: Automated Daily Gym Report** (`workflow-4-daily-report.json`)
   - `Schedule Trigger (08:30 AM IST)` &rarr; `Read Members & Payments` &rarr; `Compute 8 Daily KPIs` &rarr; `Generate Executive Dark-Themed HTML Email` &rarr; `Dispatch via Gmail to Gym Owner`.

---

## 🏗️ System Architecture

```
+---------------------------------------------------------------------------------------+
|                   ROLE-BASED WEB PORTAL & PAYMENT TOUCHPOINTS                         |
|  • Gym Owner Command Center   • Trainer Dashboard   • Member Self-Service & UPI QR    |
+--------------------+---------------------------------------------+--------------------+
                     |                                             |
                     v (REST API / Webhooks)                       v (x-razorpay-signature)
+---------------------------------------------------------------------------------------+
|                 NODE.JS + n8n WORKFLOW ENGINE (Timezone: Asia/Kolkata)                |
|                                                                                       |
|  [WF1: Registration]   [WF2: 08:00 IST Reminders]   [WF3: Payments]   [WF4: Report]   |
+--------------------+----------------------+----------------------+--------------------+
                     |                      |                      |
                     v                      v                      v
      +-----------------------------+  +------------------+  +------------------------+
      |    MongoDB Atlas Cluster    |  | Google Sheets DB |  | WhatsApp Cloud API     |
      |  (7 Live Cloud Collections) |  |  (4 Synced Tabs) |  | Razorpay + Gmail SMTP  |
      +-----------------------------+  +------------------+  +------------------------+
```

---

## 🚀 Quick Start (Local Development)

```bash
# 1. Clone the repository
git clone https://github.com/Kushalraj123/Gym-Manager-Automation-System.git
cd Gym-Manager-Automation-System

# 2. Install dependencies (official MongoDB Node.js driver)
npm install

# 3. Run the automated 6-stage end-to-end workflow & security test suite
npm test

# 4. Start the Full-Stack Server on http://localhost:3000
npm start
```

### Connect to MongoDB Atlas via CLI or UI
```bash
node scripts/connect-atlas.js "mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority"
```
Or log in to the web dashboard &rarr; click **`🍃 MongoDB Atlas Cloud`** &rarr; paste your `mongodb+srv://...` URI and click **`Connect & Sync to MongoDB Atlas`**.

---

## ☁️ Cloud Deployment (Vercel & Render + MongoDB Atlas)

This repository is pre-configured for both **Vercel** (`vercel.json` + `api/index.js`) and **Render** (`render.yaml`):

1. **MongoDB Atlas Network Access:**
   - In MongoDB Atlas &rarr; **Security &rarr; Network Access**, add **`0.0.0.0/0` (`Allow Access from Anywhere`)** so Vercel and Render cloud IPs can connect.
2. **Environment Variables (Set in Vercel & Render):**
   ```env
   MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority
   MONGODB_DB_NAME=gym_manager_saas
   TZ=Asia/Kolkata
   RAZORPAY_WEBHOOK_SECRET=gym_rzp_whsec_9f8e7d6c5b4a3f2e1d0c
   ```
3. **Connecting Vercel Frontend to an External Render Backend (Optional):**
   - By default, Vercel runs the full Node.js backend via its built-in serverless function (`/api/*`).
   - To point the Vercel UI at a dedicated Render backend URL, open the **`🍃 MongoDB Atlas Cloud`** tab and paste your Render URL into **`🌐 Backend API Server URL`**.

---

## 📂 Project Directory Structure

```text
Gym-Manager-Automation-System/
├── api/
│   └── index.js                                  # Vercel Serverless Function entry point
├── backend/
│   ├── server.js                                 # Full-Stack HTTP Server & 4 n8n Workflow Endpoints
│   ├── workflowEngine.js                         # IST Dates, Indian Phone Normalizer, Month-End Clamping, HMAC-SHA256
│   ├── sheetsDb.js                               # 4-Tab Google Sheets Engine & Auto CSV Exporter
│   └── mongoDb.js                                # Official MongoDB Atlas Two-Way Cloud Sync Adapter
├── frontend/
│   ├── index.html                                # Role-Based Login Page + Owner, Trainer & Member Portals
│   ├── styles.css                                # Modern Dark SaaS UI Theme & Responsive Layout
│   ├── app.js                                    # Frontend SPA Controller & Live Node Trace Inspector
│   └── payment-qr.png                            # PhonePe / UPI QR Code for Member Online Checkout
├── database/
│   ├── google_sheets_db.json                     # Local JSON snapshot
│   └── sheets/                                   # Ready-to-import Google Sheets CSV files
│       ├── Members.csv
│       ├── Payments.csv
│       ├── Reminder_Logs.csv
│       └── Gym_Settings.csv
├── n8n-workflows/                                # Importable n8n Workflow JSON Blueprints
│   ├── workflow-1-member-registration.json
│   ├── workflow-2-expiry-reminders.json
│   ├── workflow-3-payment-processing.json
│   └── workflow-4-daily-report.json
├── scripts/
│   ├── test-all-workflows.js                     # Automated 6-stage E2E test suite
│   └── connect-atlas.js                          # CLI helper to connect & seed MongoDB Atlas
├── vercel.json                                   # Vercel Full-Stack routing configuration
├── render.yaml                                   # Render Web Service blueprint
├── .env.example                                  # Environment variables template
└── package.json
```

---

## 💼 Commercial SaaS Business Model

- **Multi-Tenant Isolation:** Each gym client uses their own Google Sheet (`GOOGLE_SHEETS_SPREADSHEET_ID`), MongoDB Atlas database (`MONGODB_DB_NAME`), WhatsApp Business Account, and Razorpay Webhook Secret.
- **Example Commercial Pricing:**
  - **One-Time Setup & Onboarding Fee:** **₹10,000 – ₹15,000 / gym** *(Initial example setup fee)*
  - **Optional Monthly Maintenance Retainer (AMC):** **₹1,500 – ₹2,500 / month**
  - **Estimated Infrastructure Cost per Gym:** **~₹400 – ₹850 / month**
