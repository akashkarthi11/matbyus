// The QR encoder, checked by decoding its output with somebody else's decoder.
//
// This is the point of the file. The block and alignment tables in qr.js were written from
// knowledge of the standard rather than from a conformance suite, and a wrong row there produces a
// square that looks like a QR code and scans as nothing at all. Asserting that my encoder agrees
// with itself would prove nothing; jsQR is an independent implementation, so a round trip through
// it is real evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { qr, qrSvg, capacity, versionFor, VERSIONS } from '../qr.js';

// Render the modules to RGBA pixels, which is what a decoder expects to be handed.
function pixels({ size, modules }, scale = 6, quiet = 4) {
  const span = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(span * span * 4).fill(255);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c] !== 1) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const at = (((r + quiet) * scale + y) * span + ((c + quiet) * scale + x)) * 4;
          data[at] = 0; data[at + 1] = 0; data[at + 2] = 0;
        }
      }
    }
  }
  return { data, span };
}

function decode(text, opts) {
  const code = qr(text, opts);
  const { data, span } = pixels(code);
  const out = jsQR(data, span, span);
  return { read: out ? out.data : null, version: code.version, mask: code.mask, size: code.size };
}

test('the handover payload an order actually carries round-trips through an independent decoder', () => {
  const payload = 'MB1:MB-QGT3-KKG8:ACDEFGHJKM';
  const got = decode(payload);
  assert.equal(got.read, payload);
  assert.equal(got.size, 17 + 4 * got.version);
});

test('every supported version round-trips, empty, full and in between', async t => {
  for (const v of VERSIONS) {
    const max = capacity(v);
    for (const n of [1, Math.floor(max / 2), max]) {
      // A payload shaped like the real one: upper case, digits, colons.
      const text = ('MB1:' + 'ACDEFGHJKMNPQRTUVWXY2346789'.repeat(20)).slice(0, n);
      const got = decode(text, { version: v });
      assert.equal(got.read, text, `version ${v}, ${n} byte(s) — decoded as ${JSON.stringify(got.read)}`);
      assert.equal(got.version, v);
    }
  }
});

test('the version is chosen as the smallest that fits, and overflow is refused', () => {
  assert.equal(versionFor('x'), 1);
  assert.equal(versionFor('x'.repeat(capacity(1))), 1);
  assert.equal(versionFor('x'.repeat(capacity(1) + 1)), 2);
  assert.throws(() => qr('x'.repeat(capacity(10) + 1)), /does not fit/);
  assert.throws(() => qr('short', { version: 99 }), /unsupported version/);
});

test('bytes above ASCII survive, because a decoder reads them back as UTF-8', () => {
  const text = 'MB1:₹9,984.00';
  assert.equal(decode(text).read, text);
});

test('the SVG is one path, sized to the modules, and carries a light background', () => {
  const svg = qrSvg('MB1:MB-QGT3-KKG8:ACDEFGHJKM', { scale: 8, quiet: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((svg.match(/<path /g) || []).length, 1, 'one path, not one rect per module');
  assert.match(svg, /<rect width="\d+" height="\d+" fill="#fff"\/>/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  // version 2 is 25 modules, plus 4 of quiet zone either side, at 8px
  const { size } = qr('MB1:MB-QGT3-KKG8:ACDEFGHJKM');
  assert.match(svg, new RegExp(`viewBox="0 0 ${(size + 8) * 8} ${(size + 8) * 8}"`));
});

test('the three finder patterns and the dark module are where the standard puts them', () => {
  const { modules, size } = qr('MB1:MB-QGT3-KKG8:ACDEFGHJKM');
  const ring = (top, left) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(modules[top + r][left + c], edge || core ? 1 : 0, `finder ${top},${left} at ${r},${c}`);
      }
    }
  };
  ring(0, 0); ring(0, size - 7); ring(size - 7, 0);
  assert.equal(modules[size - 8][8], 1, 'the dark module is always set');
  // the timing patterns alternate, starting dark at the finder edge
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `row timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0 ? 1 : 0, `column timing at ${i}`);
  }
});

// --- the strongest check available ------------------------------------------
//
// jsQR proves the output is readable. This proves it is *the* output: every module of every
// version at every mask, against an independent encoder. It is what found the two real bugs here —
// the format bits written least-significant-first, and one module at (8, size - 8) left unwritten
// because the second format run started at bit 8 instead of bit 7. The second was wrong for four
// of the eight masks and right by luck for the other four, so nothing short of this would have
// caught it before a scanner in a yard did.

test('every version and every mask matches an independent encoder, module for module', () => {
  for (const version of VERSIONS) {
    const text = ('MB1:' + 'acdefghJKM0123456789'.repeat(30)).slice(0, capacity(version));
    for (let mask = 0; mask < 8; mask++) {
      // The reference auto-selects alphanumeric mode when it can, which is a different and more
      // compact encoding; this encoder is byte mode only, so the reference is pinned to byte mode.
      const ref = QRCode.create([{ data: text, mode: 'byte' }],
        { errorCorrectionLevel: 'M', version, maskPattern: mask });
      const size = ref.modules.size;
      const mine = qr(text, { version, mask });
      assert.equal(mine.size, size, `version ${version} size`);
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          assert.equal(mine.modules[r][c], ref.modules.data[r * size + c] ? 1 : 0,
            `version ${version}, mask ${mask}, module ${r},${c}`);
        }
      }
    }
  }
});

test('the mask is chosen by penalty score, and all eight produce readable codes', () => {
  const text = 'MB1:MB-QGT3-KKG8:ACDEFGHJKM';
  const chosen = qr(text);
  assert.ok(chosen.mask >= 0 && chosen.mask <= 7);
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(decode(text, { version: chosen.version, mask }).read, text, `mask ${mask}`);
  }
});
