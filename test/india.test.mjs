// FR-12, FR-13, NFR-9. TSD section 7.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gstinCheckChar, checkGstin, normalisePan, normalisePincode, normaliseMobile, formatMobile,
  toPaise, fromPaise, groupIndian, formatInr, gstOn, gstView, formatDateIst, formatDateTimeIst,
} from '../api/_india.js';

// The unit list and the GST state list used to be constants in _india.js and were tested here.
// They are rows in mb_units and mb_states now (migration 0005); their tests live in
// test/lookups.test.mjs, against the database the server actually reads.

// --- GSTIN ------------------------------------------------------------------
//
// TSD risk R6. These two GSTINs are the corroboration the checksum rests on: 27AAPFU0939F1ZV is
// the example carried through GST documentation, and 24AAACC1206D1ZM independently agrees. A wrong
// algorithm would match a genuine GSTIN roughly once in 36 tries, so two agreeing is meaningful —
// but it is corroboration, not a conformance suite.
//
// *** Add real GSTINs here as they become available. Until then MB_GSTIN_ENFORCE_CHECKSUM=no is
// *** the documented way to fall back to shape-and-state validation without a deploy.
const KNOWN_VALID = ['27AAPFU0939F1ZV', '24AAACC1206D1ZM'];

test('GSTIN checksum agrees with known-valid GSTINs', () => {
  for (const g of KNOWN_VALID) {
    assert.equal(gstinCheckChar(g.slice(0, 14)), g[14], g);
    assert.equal(checkGstin(g).ok, true, g);
  }
});

test('GSTIN checksum rejects every single-character alteration of a valid one', () => {
  const g = KNOWN_VALID[0];
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let checked = 0;
  for (let i = 0; i < 15; i++) {
    for (const c of alphabet) {
      if (c === g[i]) continue;
      const bad = g.slice(0, i) + c + g.slice(i + 1);
      const r = checkGstin(bad);
      // A changed character must break the shape, the state code, or the checksum — never pass.
      assert.equal(r.ok, false, bad);
      checked++;
    }
  }
  assert.ok(checked > 400, 'should have tried every alteration');
});

test('GSTIN: shape, unknown state and state mismatch are reported separately', () => {
  assert.equal(checkGstin('').reason, 'missing');
  assert.equal(checkGstin('NOT-A-GSTIN').reason, 'shape');
  assert.equal(checkGstin('27AAPFU0939F1ZV', '29').reason, 'state_mismatch');
  assert.equal(checkGstin('27AAPFU0939F1ZV', '29').gstinState, '27');
  assert.equal(checkGstin('27AAPFU0939F1ZV', '27').ok, true);
  // The state list is a table now (mb_states), so the caller supplies the check — auth.js passes
  // the database-backed one. Without it, checkGstin judges shape and checksum only.
  assert.equal(checkGstin('99AAPFU0939F1ZV', null, { isKnownState: c => c !== '99' }).reason,
    'state_unknown');
});

test('GSTIN: the checksum can be relaxed without relaxing the shape (R6 escape hatch)', () => {
  const wrongCheck = '27AAPFU0939F1ZQ';
  assert.equal(checkGstin(wrongCheck).ok, false);
  const relaxed = checkGstin(wrongCheck, null, { enforceChecksum: false });
  assert.equal(relaxed.ok, true);
  assert.equal(relaxed.checksumOk, false, 'still reports that the checksum did not agree');
  // shape is never relaxed
  assert.equal(checkGstin('27AAPFU0939F1Z', null, { enforceChecksum: false }).ok, false);
});

test('GSTIN is upper-cased and trimmed, not rejected, when typed casually', () => {
  assert.equal(checkGstin('  27aapfu0939f1zv ').value, '27AAPFU0939F1ZV');
});

// --- PAN, PIN, mobile -------------------------------------------------------

test('PAN accepts the standard shape and rejects near misses', () => {
  assert.equal(normalisePan('aapfu0939f'), 'AAPFU0939F');
  for (const bad of ['AAPFU0939', 'AAPF10939F', 'AAPFU0939FF', '', 'AAPFU093AF']) {
    assert.equal(normalisePan(bad), null, bad);
  }
});

test('PIN code is six digits starting 1-8', () => {
  assert.equal(normalisePincode('600 028'), '600028');
  for (const bad of ['060028', '900028', '60002', '6000288', 'abc123']) {
    assert.equal(normalisePincode(bad), null, bad);
  }
});

test('mobile numbers normalise from the forms people actually type', () => {
  for (const good of ['9876543210', '09876543210', '+919876543210', '+91 98765 43210',
                      '+91-98765-43210', '91 9876543210', '(98765) 43210']) {
    assert.equal(normaliseMobile(good), '+919876543210', good);
  }
  for (const bad of ['987654321', '5876543210', '98765432100', '', '+1 555 123 4567']) {
    assert.equal(normaliseMobile(bad), null, bad);
  }
  assert.equal(formatMobile('+919876543210'), '+91 98765 43210');
});

// --- money (NFR-9, D-10) ----------------------------------------------------

test('rupee strings convert to paise exactly, without touching a float', () => {
  assert.equal(toPaise('420.00'), 42000);
  assert.equal(toPaise('420'), 42000);
  assert.equal(toPaise('0.07'), 7);
  assert.equal(toPaise('1245.5'), 124550);
  assert.equal(toPaise('9999999999.99'), 999999999999);
  assert.equal(toPaise('abc'), null);
  assert.equal(toPaise('1.234'), null, 'three decimals is not money');
  assert.equal(fromPaise(124550), '1245.50');
  assert.equal(fromPaise(7), '0.07');
});

test('paise are read from the digits, so no float ever sits between the string and the integer', () => {
  assert.equal(toPaise('1234567.35'), 123456735);
  assert.equal(toPaise('0.10'), 10);
  assert.equal(toPaise('0.1'), 10);
  // The round trip is exact for every two-decimal value in a wide range.
  for (const v of ['0.01', '0.99', '1.00', '19.99', '420.05', '99999.95', '1234567.89']) {
    assert.equal(fromPaise(toPaise(v)), Number(v).toFixed(2), v);
  }
});

test('Indian digit grouping', () => {
  assert.equal(groupIndian('124500'), '1,24,500');
  assert.equal(groupIndian('1234567'), '12,34,567');
  assert.equal(groupIndian('999'), '999');
  assert.equal(groupIndian('1000'), '1,000');
  assert.equal(groupIndian('10000000'), '1,00,00,000');
  assert.equal(formatInr(12450000), '₹1,24,500.00');
  assert.equal(formatInr(42000), '₹420.00');
  assert.equal(formatInr(7), '₹0.07');
  assert.equal(formatInr(-42000), '-₹420.00');
  assert.notEqual(formatInr(12450000), '₹124,500.00', 'Western grouping reads as wrong in India');
});

// --- GST (FR-12) ------------------------------------------------------------

test('GST is computed once, half-up, to the paisa', () => {
  assert.equal(gstOn(42000, '28.00'), 11760);          // 420.00 at 28% = 117.60
  assert.equal(gstOn(12450000, '18'), 2241000);        // 124500 at 18% = 22410
  assert.equal(gstOn(100, '12.5'), 13);                // 1.00 at 12.5% = 0.125 -> 0.13 half-up
  assert.equal(gstOn(42000, 0), 0);
  assert.equal(gstOn(100, '0.5'), 1);                  // 1.00 at 0.5% = 0.005 -> 0.01 half-up
});

test('GST stays exact at the top of the numeric(12,2) range', () => {
  // The intermediate base x rate reaches 1e16 here, past the safe-integer range a float guarantees.
  // That is why gstOn multiplies in BigInt (D-10).
  const max = 999999999999;                            // 9,999,999,999.99 in paise
  assert.equal(gstOn(max, '18'), 180000000000);        // 179,999,999,999.82 -> half-up
  assert.equal(gstOn(max, '100'), max);
  assert.equal(gstOn(max, '28'), 280000000000);
});

test('an individual sees the inclusive headline, an approved business the exclusive one', () => {
  const retail = gstView(42000, '28.00', false);
  assert.equal(retail.mode, 'inclusive');
  assert.equal(retail.headlineLabel, '₹537.60');
  assert.equal(retail.taxLine, 'incl. 28% GST');

  const business = gstView(39500, '28.00', true);
  assert.equal(business.mode, 'exclusive');
  assert.equal(business.headlineLabel, '₹395.00');
  assert.equal(business.taxLine, '+ 28% GST ₹110.60');
  assert.equal(business.totalLabel, '₹505.60');
});

test('a zero rate renders no tax line at all', () => {
  const v = gstView(42000, 0, false);
  assert.equal(v.taxLine, null);
  assert.equal(v.headline, 42000);
  assert.equal(v.total, 42000);
});

test('a quote-priced product has no price and no tax', () => {
  const v = gstView(null, '18', false);
  assert.equal(v.mode, 'quote');
  assert.equal(v.headline, null);
  assert.equal(v.headlineLabel, 'Request a quote');
});

// --- dates and units --------------------------------------------------------

test('dates render as DD/MM/YYYY in IST even when the process runs in UTC', () => {
  // 2026-11-23T20:15:00Z is 2026-11-24 01:45 IST - a different day.
  assert.equal(formatDateIst('2026-11-23T20:15:00Z'), '24/11/2026');
  assert.equal(formatDateTimeIst('2026-11-23T20:15:00Z'), '24/11/2026 01:45 IST');
  assert.equal(formatDateIst('2026-11-23T10:00:00Z'), '23/11/2026');
  assert.equal(formatDateIst('nonsense'), '');
});

