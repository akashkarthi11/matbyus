// matbyus — Indian identifiers, money and formatting. TSD section 7.
//
// Two rules hold this file together:
//   1. Money never touches a JavaScript float (D-10 / NFR-9). Amounts are integer paise, and the
//      one multiplication that matters — GST — is done in BigInt so it cannot drift.
//   2. Formatting is implemented here rather than delegated to Intl, because the runtime's ICU data
//      is not something this project controls. Indian digit grouping and IST are both deterministic
//      and small; a wrong grouping shows every customer a number they read as incorrect.

// The GST state list, the unit list and every other lookup now live in the database
// (migration 0005) and are read through api/_lookups.js. What is left in this file is arithmetic
// and notation — paise, GST rounding, Indian digit grouping, IST, and the shape of an identifier —
// none of which is reference data anyone would edit.

// --- GSTIN ------------------------------------------------------------------

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Mod-36 weighted checksum over the first 14 characters. Factors alternate 1, 2, 1, 2 ...
// For each product, the tens and units in base 36 are both added to the running sum.
export function gstinCheckChar(first14) {
  const s = String(first14 || '');
  if (s.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = ALPHABET.indexOf(s[i]);
    if (v < 0) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return ALPHABET[(36 - (sum % 36)) % 36];
}

// Shape, then state code, then checksum. Returns a reason rather than a bare false so the caller
// can tell the customer which part is wrong without naming the failing character (FSD section 7).
//
// `enforceChecksum` exists because of TSD risk R6. The algorithm above is corroborated by the
// GSTINs in test/india-gstin.test.mjs, but it was implemented from a description of the standard
// rather than from a conformance suite. A checksum that is subtly wrong rejects honest customers,
// which is worse than having none. The caller passes false (driven by MB_GSTIN_ENFORCE_CHECKSUM)
// to fall back to shape-and-state validation without a code change, should that ever happen.
// `isKnownState` is supplied by the caller because the state list is a table now, and this
// function stays synchronous. auth.js passes the database-backed check; a caller that only wants
// shape and checksum passes nothing.
export function checkGstin(gstin, expectedStateCode, { enforceChecksum = true, isKnownState } = {}) {
  const g = String(gstin || '').trim().toUpperCase();
  if (!g) return { ok: false, reason: 'missing' };
  if (!GSTIN_SHAPE.test(g)) return { ok: false, reason: 'shape' };
  if (isKnownState && !isKnownState(g.slice(0, 2))) return { ok: false, reason: 'state_unknown' };
  if (expectedStateCode != null && g.slice(0, 2) !== String(expectedStateCode)) {
    return { ok: false, reason: 'state_mismatch', gstinState: g.slice(0, 2) };
  }
  const checksumOk = gstinCheckChar(g.slice(0, 14)) === g[14];
  if (!checksumOk && enforceChecksum) return { ok: false, reason: 'checksum' };
  return { ok: true, value: g, stateCode: g.slice(0, 2), checksumOk };
}

export const validGstin = (g, state, opts) => checkGstin(g, state, opts).ok;

// --- PAN, PIN code, mobile --------------------------------------------------

const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export function normalisePan(pan) {
  const p = String(pan || '').trim().toUpperCase();
  return PAN_SHAPE.test(p) ? p : null;
}

const PIN_SHAPE = /^[1-8][0-9]{5}$/;
export function normalisePincode(pin) {
  const p = String(pin || '').replace(/\s+/g, '');
  return PIN_SHAPE.test(p) ? p : null;
}

// Accepts what people actually type: 9876543210, 09876543210, +91 98765 43210, +91-98765-43210.
// Returns the stored form +91XXXXXXXXXX, or null (FR-1.3).
export function normaliseMobile(input) {
  let d = String(input || '').replace(/[\s()\-.]/g, '');
  if (d.startsWith('+91')) d = d.slice(3);
  else if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return /^[6-9][0-9]{9}$/.test(d) ? '+91' + d : null;
}

export function formatMobile(stored) {
  const m = /^\+91([6-9][0-9]{4})([0-9]{5})$/.exec(String(stored || ''));
  return m ? `+91 ${m[1]} ${m[2]}` : String(stored || '');
}

// --- Money ------------------------------------------------------------------

// Postgres numeric arrives as a string. Parsing it as a float and multiplying by 100 is the exact
// bug D-10 exists to prevent, so the digits are read directly.
export function toPaise(amount) {
  if (amount == null || amount === '') return null;
  const s = String(amount).trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const frac = (m[3] || '').padEnd(2, '0');
  const paise = BigInt(m[2]) * 100n + BigInt(frac);
  return Number(m[1] === '-' ? -paise : paise);
}

export function fromPaise(paise) {
  const n = BigInt(Math.trunc(Number(paise) || 0));
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return (neg ? '-' : '') + (abs / 100n).toString() + '.' + (abs % 100n).toString().padStart(2, '0');
}

// Indian grouping: the last three digits, then pairs. 124500 -> 1,24,500.
export function groupIndian(intDigits) {
  const s = String(intDigits);
  if (s.length <= 3) return s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  return rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
}

export function formatInr(paise, { symbol = true } = {}) {
  const n = BigInt(Math.trunc(Number(paise) || 0));
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const body = groupIndian((abs / 100n).toString()) + '.' + (abs % 100n).toString().padStart(2, '0');
  return (neg ? '-' : '') + (symbol ? '₹' : '') + body;
}

// --- GST --------------------------------------------------------------------

// Rate is a percentage, possibly with two decimals (18, 18.00, 12.5). Held as hundredths of a
// percent so the multiplication stays integral. BigInt because base paise * rate overflows the
// safe-integer range for large catalogue values.
function rateToBasisHundredths(rate) {
  const p = toPaise(rate);           // same digit parsing: 18 -> 1800, 12.5 -> 1250
  return p == null ? null : BigInt(p);
}

// Half-up to the paisa, applied once, to the final figure (FR-12.6).
export function gstOn(basePaise, rate) {
  const r = rateToBasisHundredths(rate);
  if (r == null || basePaise == null) return null;
  const base = BigInt(Math.trunc(basePaise));
  const neg = base < 0n;
  const abs = neg ? -base : base;
  const num = abs * r;
  const den = 10000n;                 // percent (100) x hundredths (100)
  const tax = (num + den / 2n) / den;
  return Number(neg ? -tax : tax);
}

// FR-12. `businessView` is true only for an approved business account; everyone else sees the
// inclusive headline, because that is the number a retail buyer actually pays.
export function gstView(basePaise, rate, businessView) {
  if (basePaise == null) {
    return { mode: 'quote', headline: null, headlineLabel: 'Request a quote', taxLine: null, total: null };
  }
  const tax = gstOn(basePaise, rate) || 0;
  const incl = basePaise + tax;
  const rateLabel = String(Number(rate) || 0).replace(/\.00$/, '');
  if (tax === 0) {
    return {
      mode: businessView ? 'exclusive' : 'inclusive',
      headline: basePaise, headlineLabel: formatInr(basePaise),
      taxLine: null, total: basePaise, rate: Number(rate) || 0,
    };
  }
  return businessView
    ? {
        mode: 'exclusive', headline: basePaise, headlineLabel: formatInr(basePaise),
        taxLine: `+ ${rateLabel}% GST ${formatInr(tax)}`, total: incl, totalLabel: formatInr(incl),
        tax, rate: Number(rate) || 0,
      }
    : {
        mode: 'inclusive', headline: incl, headlineLabel: formatInr(incl),
        taxLine: `incl. ${rateLabel}% GST`, total: incl, totalLabel: formatInr(incl),
        tax, rate: Number(rate) || 0,
      };
}

// --- Dates ------------------------------------------------------------------

// IST is UTC+05:30 with no daylight saving, so the shift is exact and needs no timezone database.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function formatDateIst(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const i = new Date(d.getTime() + IST_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return `${p(i.getUTCDate())}/${p(i.getUTCMonth() + 1)}/${i.getUTCFullYear()}`;
}

export function formatDateTimeIst(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const i = new Date(d.getTime() + IST_OFFSET_MS);
  const p = n => String(n).padStart(2, '0');
  return `${formatDateIst(d)} ${p(i.getUTCHours())}:${p(i.getUTCMinutes())} IST`;
}
