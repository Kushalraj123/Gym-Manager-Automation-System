/**
 * ============================================================================
 * GOOGLE SHEETS 4-TAB DATABASE ENGINE & CSV EXPORTER
 * ============================================================================
 * Mirrors the exact 4 tabs required in Google Sheets:
 *   1. Members
 *   2. Payments
 *   3. Reminder_Logs
 *   4. Gym_Settings
 *
 * Also writes out clean CSV files in /database/sheets/ so the user can import
 * them directly into Google Sheets with 1 click.
 */

const fs = require('fs');
const path = require('path');
const {
  getTodayIST,
  addMonthsClamped,
  calculateDaysDifference,
} = require('./workflowEngine');
const {
  syncLocalToMongoAtlas,
} = require('./mongoDb');

const DB_DIR = path.join(__dirname, '..', 'database');
const SHEETS_CSV_DIR = path.join(DB_DIR, 'sheets');
const DB_JSON_PATH = path.join(DB_DIR, 'google_sheets_db.json');

const SHEET_SCHEMAS = {
  Members: [
    'Member_ID',
    'Name',
    'Phone',
    'Email',
    'Plan',
    'Joining_Date',
    'Expiry_Date',
    'Payment_Status',
    'Payment_Method',
    'WhatsApp_Consent',
    'Last_Reminder_Date',
    'Member_Status',
  ],
  Payments: [
    'Payment_ID',
    'Member_ID',
    'Amount',
    'Payment_Method',
    'Payment_Status',
    'Payment_Date',
    'Razorpay_Reference',
    'Webhook_Processed',
  ],
  Reminder_Logs: [
    'Reminder_ID',
    'Member_ID',
    'Phone',
    'Reminder_Type',
    'Sent_Date',
    'Delivery_Status',
  ],
  Gym_Settings: [
    'Gym_Name',
    'Owner_Email',
    'WhatsApp_Number',
    'Monthly_Plan_Price',
    'Quarterly_Plan_Price',
    'Half_Yearly_Plan_Price',
    'Yearly_Plan_Price',
    'Reminder_Time',
  ],
};

function addDays(dateStr, offsetDays) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + offsetDays));
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Generates realistic initial Indian gym data relative to today's IST date
 * so that:
 * - Expiring in 3 days (3DAY_EXPIRY) has ready test members
 * - Expiring Today (TODAY_EXPIRY) has ready test members
 * - Expired memberships exist
 * - Active memberships exist
 * - Pending and Paid payments exist
 */
function buildInitialSeedData(referenceToday = null) {
  const today = referenceToday || getTodayIST();
  const in3Days = addDays(today, 3);
  const minus30Days = addDays(today, -30);
  const minus27Days = addDays(today, -27);
  const minus45Days = addDays(today, -45);
  const minus15Days = addDays(today, -15);
  const plus25Days = addDays(today, 25);
  const plus75Days = addDays(today, 75);
  const plus340Days = addDays(today, 340);

  return {
    Gym_Settings: [
      {
        Gym_Name: 'IronFit Pro Fitness Studio',
        Owner_Email: 'owner@ironfitgym.in',
        WhatsApp_Number: '919820011223',
        Monthly_Plan_Price: 2000,
        Quarterly_Plan_Price: 4000,
        Half_Yearly_Plan_Price: 6000,
        Yearly_Plan_Price: 9000,
        Reminder_Time: '08:00',
      },
    ],
    Members: [
      {
        Member_ID: 'GYM-1001',
        Name: 'Aarav Sharma',
        Phone: '919876543210',
        Email: 'aarav.sharma@example.in',
        Plan: 'Quarterly',
        Joining_Date: minus15Days,
        Expiry_Date: plus75Days,
        Payment_Status: 'Paid',
        Payment_Method: 'Razorpay',
        WhatsApp_Consent: 'TRUE',
        Last_Reminder_Date: '',
        Member_Status: 'Active',
      },
      {
        Member_ID: 'GYM-1002',
        Name: 'Priya Patel',
        Phone: '919876543211',
        Email: 'priya.patel@example.in',
        Plan: 'Monthly',
        Joining_Date: minus27Days,
        Expiry_Date: in3Days, // Expires in exactly 3 days!
        Payment_Status: 'Paid',
        Payment_Method: 'UPI',
        WhatsApp_Consent: 'TRUE',
        Last_Reminder_Date: '',
        Member_Status: 'Expiring Soon',
      },
      {
        Member_ID: 'GYM-1003',
        Name: 'Rohan Verma',
        Phone: '919876543212',
        Email: 'rohan.verma@example.in',
        Plan: 'Monthly',
        Joining_Date: minus30Days,
        Expiry_Date: today, // Expires TODAY!
        Payment_Status: 'Paid',
        Payment_Method: 'Cash',
        WhatsApp_Consent: 'TRUE',
        Last_Reminder_Date: '',
        Member_Status: 'Expiring Today',
      },
      {
        Member_ID: 'GYM-1004',
        Name: 'Sneha Nair',
        Phone: '919876543213',
        Email: 'sneha.nair@example.in',
        Plan: 'Monthly',
        Joining_Date: minus45Days,
        Expiry_Date: minus15Days, // Already Expired
        Payment_Status: 'Pending',
        Payment_Method: 'Razorpay',
        WhatsApp_Consent: 'TRUE',
        Last_Reminder_Date: minus15Days,
        Member_Status: 'Expired',
      },
      {
        Member_ID: 'GYM-1005',
        Name: 'Vikram Singhania',
        Phone: '919876543214',
        Email: 'vikram.s@example.in',
        Plan: 'Yearly',
        Joining_Date: today,
        Expiry_Date: plus340Days,
        Payment_Status: 'Paid',
        Payment_Method: 'Razorpay',
        WhatsApp_Consent: 'TRUE',
        Last_Reminder_Date: '',
        Member_Status: 'Active',
      },
      {
        Member_ID: 'GYM-1006',
        Name: 'Ananya Gupta',
        Phone: '919876543215',
        Email: 'ananya.g@example.in',
        Plan: 'Monthly',
        Joining_Date: minus27Days,
        Expiry_Date: in3Days, // Expires in 3 days, but WhatsApp_Consent is FALSE
        Payment_Status: 'Paid',
        Payment_Method: 'Cash',
        WhatsApp_Consent: 'FALSE',
        Last_Reminder_Date: '',
        Member_Status: 'Expiring Soon',
      },
      {
        Member_ID: 'GYM-1007',
        Name: 'Karthik Reddy',
        Phone: '919876543216',
        Email: 'karthik.r@example.in',
        Plan: 'Monthly',
        Joining_Date: today,
        Expiry_Date: plus25Days,
        Payment_Status: 'Pending',
        Payment_Method: 'UPI',
        WhatsApp_Consent: 'TRUE',
        Last_Reminder_Date: '',
        Member_Status: 'Active',
      },
    ],
    Payments: [
      {
        Payment_ID: 'PAY-5001',
        Member_ID: 'GYM-1001',
        Amount: 4000,
        Payment_Method: 'Razorpay',
        Payment_Status: 'Paid',
        Payment_Date: minus15Days,
        Razorpay_Reference: 'pay_RzpSeedRef1001',
        Webhook_Processed: 'TRUE',
      },
      {
        Payment_ID: 'PAY-5002',
        Member_ID: 'GYM-1002',
        Amount: 2000,
        Payment_Method: 'UPI',
        Payment_Status: 'Paid',
        Payment_Date: minus27Days,
        Razorpay_Reference: 'UPI-2026-88412',
        Webhook_Processed: 'TRUE',
      },
      {
        Payment_ID: 'PAY-5003',
        Member_ID: 'GYM-1003',
        Amount: 2000,
        Payment_Method: 'Cash',
        Payment_Status: 'Paid',
        Payment_Date: minus30Days,
        Razorpay_Reference: 'CASH-RECEIPT-103',
        Webhook_Processed: 'TRUE',
      },
      {
        Payment_ID: 'PAY-5004',
        Member_ID: 'GYM-1005',
        Amount: 9000,
        Payment_Method: 'Razorpay',
        Payment_Status: 'Paid',
        Payment_Date: today,
        Razorpay_Reference: 'pay_RzpSeedRef1005',
        Webhook_Processed: 'TRUE',
      },
      {
        Payment_ID: 'PAY-5005',
        Member_ID: 'GYM-1007',
        Amount: 2000,
        Payment_Method: 'UPI',
        Payment_Status: 'Pending',
        Payment_Date: today,
        Razorpay_Reference: 'PENDING-GYM-1007',
        Webhook_Processed: 'FALSE',
      },
    ],
    Reminder_Logs: [
      {
        Reminder_ID: 'REM-9001',
        Member_ID: 'GYM-1004',
        Phone: '919876543213',
        Reminder_Type: 'TODAY_EXPIRY',
        Sent_Date: minus15Days,
        Delivery_Status: 'SENT (wamid.HBgMOTE5ODc2NTQzMjEzFQIAERgSRjA1)',
      },
    ],
    Trainers: [
      {
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
        Pin: '1234',
      },
      {
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
        Pin: '1234',
      },
    ],
    Member_Profiles: {
      'GYM-1001': {
        Assigned_Trainer_ID: 'TRN-201',
        Workout_Plan: '4-Day Upper / Lower Strength Split (Bench, Squat, Deadlift, Overhead Press)',
        Diet_Notes: 'High Protein (140g/day) • 2,400 kcal • Creatine 5g post-workout',
        Attendance_Count: 18,
        Last_CheckIn: today,
      },
      'GYM-1002': {
        Assigned_Trainer_ID: 'TRN-202',
        Workout_Plan: '3-Day Full Body Circuit + 2-Day HIIT Cardio Conditioning',
        Diet_Notes: 'Calorie Deficit (1,650 kcal) • 100g Protein • 3L Hydration',
        Attendance_Count: 14,
        Last_CheckIn: minus15Days,
      },
      'GYM-1003': {
        Assigned_Trainer_ID: 'TRN-201',
        Workout_Plan: 'Push / Pull / Legs (6-Day Intermediate Hypertrophy)',
        Diet_Notes: 'Maintenance (2,200 kcal) • Pre-workout Complex Carbs',
        Attendance_Count: 22,
        Last_CheckIn: today,
      },
      'GYM-1004': {
        Assigned_Trainer_ID: 'TRN-202',
        Workout_Plan: 'Core Stability & Functional Strength Foundation',
        Diet_Notes: 'Balanced Macro Split (40% Carbs / 30% Protein / 30% Fats)',
        Attendance_Count: 9,
        Last_CheckIn: minus15Days,
      },
      'GYM-1005': {
        Assigned_Trainer_ID: 'TRN-201',
        Workout_Plan: '5-Day Powerbuilding Program + Olympic Lifts',
        Diet_Notes: 'Lean Bulk (2,750 kcal) • 160g Protein • Electrolytes',
        Attendance_Count: 26,
        Last_CheckIn: today,
      },
      'GYM-1006': {
        Assigned_Trainer_ID: 'TRN-202',
        Workout_Plan: '3-Day Kettlebell & Mobility Flow',
        Diet_Notes: '1,800 kcal Whole-Food Plan',
        Attendance_Count: 11,
        Last_CheckIn: minus15Days,
      },
      'GYM-1007': {
        Assigned_Trainer_ID: 'TRN-201',
        Workout_Plan: 'Beginner 3-Day Compound Strength Routine',
        Diet_Notes: '2,100 kcal High-Protein Vegetarian Plan',
        Attendance_Count: 3,
        Last_CheckIn: today,
      },
    },
    Execution_Audit_Logs: [],
  };
}

function toCSV(headers, rows) {
  const escapeCell = (val) => {
    const str = val === null || val === undefined ? '' : String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const headerLine = headers.join(',');
  const dataLines = rows.map((row) => headers.map((h) => escapeCell(row[h])).join(','));
  return [headerLine, ...dataLines].join('\n') + '\n';
}

// In-memory cache so serverless/read-only environments (like Vercel) remain fast & functional alongside MongoDB Atlas
let inMemoryDbCache = null;

function syncCSVFiles(dbData) {
  try {
    if (!fs.existsSync(SHEETS_CSV_DIR)) {
      fs.mkdirSync(SHEETS_CSV_DIR, { recursive: true });
    }
    for (const [sheetName, headers] of Object.entries(SHEET_SCHEMAS)) {
      const rows = dbData[sheetName] || [];
      const csvContent = toCSV(headers, rows);
      fs.writeFileSync(path.join(SHEETS_CSV_DIR, `${sheetName}.csv`), csvContent, 'utf8');
    }
  } catch (_) {}
}

function loadDatabase() {
  if (inMemoryDbCache) {
    return inMemoryDbCache;
  }
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
  } catch (_) {}

  if (!fs.existsSync(DB_JSON_PATH)) {
    const initial = buildInitialSeedData();
    saveDatabase(initial);
    return initial;
  }
  try {
    const raw = fs.readFileSync(DB_JSON_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const seed = buildInitialSeedData();
    let needsSave = false;
    if (!parsed.Trainers || !parsed.Member_Profiles || !parsed.Trainers[0]?.Certifications) {
      parsed.Trainers = seed.Trainers;
      parsed.Member_Profiles = parsed.Member_Profiles || seed.Member_Profiles;
      needsSave = true;
    }
    if (
      parsed.Gym_Settings &&
      parsed.Gym_Settings[0] &&
      (parsed.Gym_Settings[0].Monthly_Plan_Price === 1500 || !parsed.Gym_Settings[0].Half_Yearly_Plan_Price)
    ) {
      parsed.Gym_Settings[0].Monthly_Plan_Price = 2000;
      parsed.Gym_Settings[0].Quarterly_Plan_Price = 4000;
      parsed.Gym_Settings[0].Half_Yearly_Plan_Price = 6000;
      parsed.Gym_Settings[0].Yearly_Plan_Price = 9000;
      needsSave = true;
    }
    inMemoryDbCache = parsed;
    if (needsSave) saveDatabase(parsed);
    return parsed;
  } catch (e) {
    const initial = buildInitialSeedData();
    saveDatabase(initial);
    return initial;
  }
}

function saveDatabase(dbData) {
  // Automatically refresh Member_Status based on Expiry_Date relative to today IST
  const today = getTodayIST();
  if (Array.isArray(dbData.Members)) {
    for (const m of dbData.Members) {
      if (m.Expiry_Date) {
        const diff = calculateDaysDifference(m.Expiry_Date, today);
        if (diff < 0) m.Member_Status = 'Expired';
        else if (diff === 0) m.Member_Status = 'Expiring Today';
        else if (diff <= 3) m.Member_Status = 'Expiring Soon';
        else m.Member_Status = 'Active';
      }
    }
  }
  inMemoryDbCache = dbData;
  try {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    fs.writeFileSync(DB_JSON_PATH, JSON.stringify(dbData, null, 2), 'utf8');
    syncCSVFiles(dbData);
  } catch (_) {}
  // Automatically mirror every database write to MongoDB Atlas in the background if connected
  syncLocalToMongoAtlas(dbData).catch(() => {});
  return dbData;
}

function resetDatabase(referenceToday = null) {
  const seeded = buildInitialSeedData(referenceToday);
  saveDatabase(seeded);
  return seeded;
}

module.exports = {
  SHEET_SCHEMAS,
  loadDatabase,
  saveDatabase,
  resetDatabase,
  SHEETS_CSV_DIR,
  DB_JSON_PATH,
};
