/**
 * ============================================================================
 * CORE BUSINESS LOGIC ENGINE (Shared between n8n Code Nodes & Backend Server)
 * ============================================================================
 * Every function in this file mirrors the exact JavaScript code used inside
 * the n8n Code Nodes across Workflows 1, 2, 3, and 4.
 *
 * Timezone: Asia/Kolkata (IST, UTC+05:30)
 * Date Format: YYYY-MM-DD
 */

const crypto = require('crypto');

/**
 * Returns a Date object or YYYY-MM-DD string in Asia/Kolkata (IST) timezone.
 * If referenceDateStr (YYYY-MM-DD) is passed, uses that date; otherwise uses current IST date.
 */
function getTodayIST(referenceDateStr = null) {
  if (referenceDateStr && /^\d{4}-\d{2}-\d{2}$/.test(referenceDateStr)) {
    return referenceDateStr;
  }
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now); // en-CA formats as YYYY-MM-DD
}

/**
 * Returns current IST timestamp in ISO-like readable format: YYYY-MM-DD HH:mm:ss IST
 */
function getTimestampIST() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

/**
 * Normalizes an Indian Phone Number to strict 10-digit E.164 (91XXXXXXXXXX).
 * Accepts:
 *  - "9876543210"
 *  - "+91 98765-43210"
 *  - "09876543210"
 *  - "919876543210"
 *
 * Validates that the 10-digit mobile number starts with 6, 7, 8, or 9.
 */
function normalizeIndianPhone(rawPhone) {
  if (!rawPhone && rawPhone !== 0) {
    return { valid: false, error: 'Phone number is required.' };
  }
  const digitsOnly = String(rawPhone).replace(/\D/g, '');
  let tenDigit = digitsOnly;

  if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
    tenDigit = digitsOnly.slice(2);
  } else if (digitsOnly.length === 11 && digitsOnly.startsWith('0')) {
    tenDigit = digitsOnly.slice(1);
  } else if (digitsOnly.length === 13 && digitsOnly.startsWith('091')) {
    tenDigit = digitsOnly.slice(3);
  }

  if (!/^[6-9]\d{9}$/.test(tenDigit)) {
    return {
      valid: false,
      error: `Invalid Indian mobile number (${rawPhone}). Must be 10 digits starting with 6, 7, 8, or 9.`,
    };
  }

  return {
    valid: true,
    phone10: tenDigit,
    phoneE164: `91${tenDigit}`,
    formatted: `+91 ${tenDigit.slice(0, 5)} ${tenDigit.slice(5)}`,
  };
}

/**
 * Adds months to a YYYY-MM-DD date string while properly clamping month-end dates.
 * Example:
 *  - addMonthsClamped("2026-01-31", 1) -> "2026-02-28"
 *  - addMonthsClamped("2024-01-31", 1) -> "2024-02-29" (leap year)
 *  - addMonthsClamped("2026-05-31", 1) -> "2026-06-30"
 */
function addMonthsClamped(dateStr, monthsToAdd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date format "${dateStr}". Expected YYYY-MM-DD.`);
  }
  const [year, month, day] = dateStr.split('-').map(Number);
  const numMonths = Number(monthsToAdd);
  if (isNaN(numMonths) || numMonths <= 0) {
    throw new Error(`Invalid duration months: ${monthsToAdd}`);
  }

  // Target year & 0-indexed target month
  const totalMonths = (month - 1) + numMonths;
  const targetYear = year + Math.floor(totalMonths / 12);
  const targetMonthIndex = totalMonths % 12; // 0 = Jan, 1 = Feb...

  // Get max days in targetMonthIndex (Day 0 of next month gives last day of target month)
  const maxDaysInTargetMonth = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, maxDaysInTargetMonth);

  const yyyy = String(targetYear);
  const mm = String(targetMonthIndex + 1).padStart(2, '0');
  const dd = String(clampedDay).padStart(2, '0');

  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Maps plan name or explicit duration to number of months.
 */
function resolveDurationMonths(plan, explicitMonths) {
  if (explicitMonths && Number(explicitMonths) > 0) {
    return Number(explicitMonths);
  }
  const normalized = String(plan || '').toLowerCase();
  if (normalized.includes('year') || normalized.includes('annual') || normalized === '12') return 12;
  if (normalized.includes('half') || normalized.includes('6') || normalized === '6') return 6;
  if (normalized.includes('quarter') || normalized.includes('3') || normalized === '3') return 3;
  return 1; // Default Monthly
}

/**
 * Resolves standard plan amount from Gym_Settings based on plan / duration.
 * Pricing:
 *  - 1 Month  (Monthly)     = ₹2,000
 *  - 3 Months (Quarterly)   = ₹4,000
 *  - 6 Months (Half-Yearly) = ₹6,000
 *  - 1 Year   (Yearly)      = ₹9,000
 */
function resolvePlanPrice(plan, durationMonths, settings) {
  const months = resolveDurationMonths(plan, durationMonths);
  const monthly = Number(settings?.Monthly_Plan_Price || 2000);
  const quarterly = Number(settings?.Quarterly_Plan_Price || 4000);
  const halfYearly = Number(settings?.Half_Yearly_Plan_Price || 6000);
  const yearly = Number(settings?.Yearly_Plan_Price || 9000);

  if (months === 12) return yearly;
  if (months === 6) return halfYearly;
  if (months === 3) return quarterly;
  return monthly * months;
}

/**
 * Calculates calendar day difference between targetDateStr (YYYY-MM-DD) and todayStr (YYYY-MM-DD).
 * Returns:
 *   > 0 : expires in N days
 *   = 0 : expires today
 *   < 0 : expired N days ago
 */
function calculateDaysDifference(targetDateStr, todayStr = null) {
  const baseStr = todayStr || getTodayIST();
  const [y1, m1, d1] = baseStr.split('-').map(Number);
  const [y2, m2, d2] = targetDateStr.split('-').map(Number);

  const utcBase = Date.UTC(y1, m1 - 1, d1);
  const utcTarget = Date.UTC(y2, m2 - 1, d2);
  const diffMs = utcTarget - utcBase;
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Generates next sequential ID (e.g., GYM-1001, PAY-5001, REM-9001)
 */
function generateSequentialId(prefix, existingRows, idField, startNumber = 1001) {
  let maxNum = startNumber - 1;
  for (const row of existingRows) {
    const val = String(row[idField] || '');
    const match = val.match(/(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }
  return `${prefix}-${maxNum + 1}`;
}

/**
 * Verifies a Razorpay Webhook HMAC-SHA256 signature using the raw request body and webhook secret.
 * Never trusts browser redirects or unverified payloads.
 */
function verifyRazorpaySignature(rawBodyString, signatureHeader, webhookSecret) {
  if (!rawBodyString || !signatureHeader || !webhookSecret) {
    return { verified: false, reason: 'Missing raw body, x-razorpay-signature header, or webhook secret.' };
  }
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBodyString, 'utf8')
    .digest('hex');

  try {
    const sigBuf = Buffer.from(String(signatureHeader), 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expBuf.length) {
      return { verified: false, reason: 'Signature length mismatch.', expectedSignature };
    }
    const isMatch = crypto.timingSafeEqual(sigBuf, expBuf);
    return {
      verified: isMatch,
      reason: isMatch ? 'Valid HMAC-SHA256 signature' : 'HMAC signature mismatch',
      expectedSignature,
    };
  } catch (err) {
    return { verified: false, reason: err.message };
  }
}

/**
 * Helper to generate a valid HMAC-SHA256 signature for testing Razorpay Webhooks locally.
 */
function createRazorpayTestSignature(rawBodyString, webhookSecret) {
  return crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBodyString, 'utf8')
    .digest('hex');
}

/**
 * Calculates renewal expiry date:
 * - If member's current Expiry_Date is in the future (>= today), extends from current Expiry_Date.
 * - If member's current Expiry_Date is already expired (< today), extends from today (payment date).
 */
function calculateRenewalExpiryDate(currentExpiryDate, todayStr, durationMonths) {
  const daysRemaining = calculateDaysDifference(currentExpiryDate, todayStr);
  const baseDate = daysRemaining >= 0 ? currentExpiryDate : todayStr;
  return {
    baseDateUsed: baseDate,
    wasExpired: daysRemaining < 0,
    newExpiryDate: addMonthsClamped(baseDate, durationMonths),
  };
}

module.exports = {
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
};
