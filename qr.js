// qr.js — a QR encoder. Byte mode, error correction level M, versions 1 to 10.
//
// Written rather than imported because this file ships to the browser and the project loads no
// external scripts: a third-party CDN in the page would put the handover code's rendering, and the
// page's integrity, in someone else's hands.
//
// Everything here is verifiable, and is verified. test/qr.test.mjs renders the output to pixels and
// decodes it with **jsQR**, an independent decoder, at every version and several payload lengths.
// That matters: the block tables below were written from knowledge of the standard, not from a
// conformance suite, and a table that is subtly wrong produces a square that looks like a QR code
// and scans as nothing. An independent decoder is the only honest check, and it is a real one —
// unlike the GSTIN checksum elsewhere in this project, which has no decoder to appeal to.
//
// Level M (recovers ~15%) rather than L: this is read off a phone screen, in a yard, at an angle,
// possibly through a cracked protector.

// --- GF(256), primitive polynomial 0x11D -------------------------------------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

// The generator polynomial for n error correction codewords: (x - a^0)(x - a^1)...(x - a^(n-1)).
// Coefficients descend, so poly[0] is the coefficient of the highest power and is always 1.
function generator(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

// Polynomial long division; the remainder is the error correction codewords.
function remainder(data, n) {
  const gen = generator(n);
  const buf = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const lead = buf[i];
    if (lead === 0) continue;
    for (let j = 1; j < gen.length; j++) buf[i + j] ^= mul(gen[j], lead);
  }
  return buf.slice(data.length);
}

// --- version tables -----------------------------------------------------------

// Total codewords, data plus error correction, per version.
const TOTAL = { 1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346 };

// Level M block structure: [ errorCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...] ].
// Each row is checked against TOTAL at load, below, which catches a mistyped figure immediately.
const BLOCKS_M = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};

// Centres of the alignment patterns. Version 1 has none.
const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

// Bits left over after the last codeword, which are placed as zeros.
const REMAINDER_BITS = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

export const VERSIONS = Object.keys(BLOCKS_M).map(Number);

const dataCodewords = version => {
  const [ec, groups] = BLOCKS_M[version];
  return groups.reduce((n, [count, each]) => n + count * each, 0);
};

const blockCount = version =>
  BLOCKS_M[version][1].reduce((n, [count]) => n + count, 0);

// A mistyped table is the one failure that would produce a scannable-looking square that decodes as
// nothing, so it is checked here instead of being discovered in a yard.
for (const v of VERSIONS) {
  const [ec] = BLOCKS_M[v];
  const total = dataCodewords(v) + ec * blockCount(v);
  if (total !== TOTAL[v]) {
    throw new Error(`qr.js: version ${v} block table does not add up: ${total} vs ${TOTAL[v]}`);
  }
}

// Byte mode carries an 8-bit length up to version 9 and a 16-bit length from version 10.
const lengthBits = version => (version <= 9 ? 8 : 16);

// How many bytes fit, allowing for the 4-bit mode indicator and the length field.
export function capacity(version) {
  return dataCodewords(version) - 1 - (lengthBits(version) > 8 ? 2 : 1);
}

// --- BCH, for the format and version information ---------------------------------
//
// Computed rather than tabulated. The 32 format strings and 34 version strings are published, but
// copying them from memory is how a subtle error gets in; the generator polynomials are short
// enough to be obviously right.

function formatInfo(mask) {
  const data = (0b00 << 3) | mask;          // 00 is level M
  let rem = data << 10;
  for (let i = 4; i >= 0; i--) if (rem & (1 << (i + 10))) rem ^= 0x537 << i;
  return ((data << 10) | rem) ^ 0x5412;     // 15 bits
}

function versionInfo(version) {
  let rem = version << 12;
  for (let i = 5; i >= 0; i--) if (rem & (1 << (i + 12))) rem ^= 0x1f25 << i;
  return (version << 12) | rem;             // 18 bits
}

// --- the data bit stream --------------------------------------------------------

function bitStream(bytes, version) {
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                          // byte mode
  push(bytes.length, lengthBits(version));
  for (const b of bytes) push(b, 8);

  const limit = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < limit; i++) bits.push(0);   // terminator
  while (bits.length % 8) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    words.push(bits.slice(i, i + 8).reduce((n, b) => (n << 1) | b, 0));
  }
  // Pad bytes alternate, by the standard, so an empty tail is not a long run of one colour.
  const PAD = [0xec, 0x11];
  for (let i = 0; words.length < dataCodewords(version); i++) words.push(PAD[i % 2]);
  return words;
}

// Data codewords are interleaved across blocks, then the error codewords are, so that damage to one
// region of the square is spread across every block rather than destroying one of them.
function interleave(words, version) {
  const [ecCount, groups] = BLOCKS_M[version];
  const blocks = [];
  let at = 0;
  for (const [count, each] of groups) {
    for (let i = 0; i < count; i++) {
      const data = words.slice(at, at + each);
      at += each;
      blocks.push({ data, ec: remainder(data, ecCount) });
    }
  }

  const out = [];
  const widest = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < widest; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const b of blocks) out.push(b.ec[i]);
  }
  return out;
}

// --- the matrix ------------------------------------------------------------------

const FUNCTION = 2;        // a cell value meaning "reserved, not maskable"

function blank(version) {
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));

  const finder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const y = top + r, x = left + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6 &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        m[y][x] = ring ? 1 : 0;
      }
    }
  };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    const on = i % 2 === 0 ? 1 : 0;
    m[6][i] = on;
    m[i][6] = on;
  }

  // alignment patterns, except where they would sit on a finder
  const centres = ALIGN[version];
  for (const cy of centres) {
    for (const cx of centres) {
      const onFinder = (cy <= 8 && cx <= 8) || (cy <= 8 && cx >= size - 9) || (cy >= size - 9 && cx <= 8);
      if (onFinder) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          m[cy + r][cx + c] = (Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0)) ? 1 : 0;
        }
      }
    }
  }

  // the dark module, which is always set
  m[size - 8][8] = 1;

  // reserve the format areas so data skips them
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = FUNCTION;
    if (m[i][8] === null) m[i][8] = FUNCTION;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) m[8][size - 1 - i] = FUNCTION;
    if (m[size - 1 - i][8] === null) m[size - 1 - i][8] = FUNCTION;
  }

  // and the version areas, from version 7
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3), c = i % 3;
      if (m[size - 11 + c][r] === null) m[size - 11 + c][r] = FUNCTION;
      if (m[r][size - 11 + c] === null) m[r][size - 11 + c] = FUNCTION;
    }
  }
  return m;
}

// Two columns at a time, right to left, zigzagging up then down, skipping the vertical timing line.
function place(m, codewords) {
  const size = m.length;
  const bits = [];
  for (const w of codewords) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);

  let at = 0, upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5;                      // column 6 is the timing pattern
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (m[row][col] !== null) continue;
        m[row][col] = at < bits.length ? bits[at] : 0;   // remainder bits are zeros
        at++;
      }
    }
    upward = !upward;
  }
  return at;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r, c) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// The penalty rules from the standard. These only decide which of eight equally valid encodings is
// easiest for a scanner, so an imperfect score costs legibility, never correctness.
function penalty(grid) {
  const size = grid.length;
  let score = 0;

  const run = line => {
    let total = 0, length = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) { length++; continue; }
      if (length >= 5) total += 3 + (length - 5);
      length = 1;
    }
    if (length >= 5) total += 3 + (length - 5);
    return total;
  };
  for (let i = 0; i < size; i++) {
    score += run(grid[i]);
    score += run(grid.map(r => r[i]));
  }

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
  }

  const FINDERISH = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const matches = line => {
    let n = 0;
    for (let i = 0; i + 11 <= line.length; i++) {
      let fwd = true, back = true;
      for (let j = 0; j < 11; j++) {
        if (line[i + j] !== FINDERISH[j]) fwd = false;
        if (line[i + j] !== FINDERISH[10 - j]) back = false;
      }
      if (fwd || back) n++;
    }
    return n * 40;
  };
  for (let i = 0; i < size; i++) {
    score += matches(grid[i]);
    score += matches(grid.map(r => r[i]));
  }

  const dark = grid.flat().filter(v => v === 1).length;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function writeFormat(grid, mask) {
  const size = grid.length;
  const bits = formatInfo(mask);
  // The 15 format bits are laid out most significant first along the order below. Writing them
  // least significant first produces a code whose data is perfect and which no scanner will read,
  // because the one thing it cannot be told is which mask to undo. Established against a reference
  // encoder, not from memory — see test/qr.test.mjs.
  const bit = i => (bits >> (14 - i)) & 1;

  for (let i = 0; i <= 5; i++) grid[8][i] = bit(i);
  grid[8][7] = bit(6);
  grid[8][8] = bit(7);
  grid[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) grid[14 - i][8] = bit(i);

  // The second copy is 7 modules up the column beside the bottom-left finder, then 8 along the row
  // under the top-right finder. Starting that row at bit 8 rather than bit 7 leaves exactly one
  // module unwritten, at (8, size - 8) — which is wrong for half the masks and right by luck for
  // the other half, so it survives a cursory test and fails in the yard.
  for (let i = 0; i <= 6; i++) grid[size - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i++) grid[8][size - 15 + i] = bit(i);
  grid[size - 8][8] = 1;                                  // the dark module sits above that run
}

function writeVersion(grid, version) {
  if (version < 7) return;
  const size = grid.length;
  const bits = versionInfo(version);
  for (let i = 0; i < 18; i++) {
    const b = (bits >> i) & 1;
    const r = Math.floor(i / 3), c = i % 3;
    grid[size - 11 + c][r] = b;
    grid[r][size - 11 + c] = b;
  }
}

// --- the public shape --------------------------------------------------------------

const utf8 = text => [...new TextEncoder().encode(String(text))];

export function versionFor(text) {
  const n = utf8(text).length;
  const v = VERSIONS.find(x => n <= capacity(x));
  if (!v) {
    throw new Error(`qr.js: ${n} bytes does not fit in a version 10 code (max ${capacity(10)})`);
  }
  return v;
}

// Returns { size, modules } where modules is an array of rows of 0 and 1. 1 is dark.
export function qr(text, { version = null, mask: forceMask = null } = {}) {
  const bytes = utf8(text);
  const v = version || versionFor(text);
  if (!BLOCKS_M[v]) throw new Error(`qr.js: unsupported version ${v}`);
  if (bytes.length > capacity(v)) {
    throw new Error(`qr.js: ${bytes.length} bytes does not fit in version ${v} (max ${capacity(v)})`);
  }

  const codewords = interleave(bitStream(bytes, v), v);
  const template = blank(v);
  place(template, codewords);

  let best = null;
  const tryMasks = forceMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forceMask];
  for (const mask of tryMasks) {
    const grid = template.map((row, r) => row.map((cell, c) => {
      if (cell === FUNCTION) return 0;
      if (cell === null) return 0;
      // Only the data region is masked; the patterns laid down in blank() are not.
      const isData = template[r][c] !== FUNCTION && !isFunctionCell(v, r, c);
      return isData && MASKS[mask](r, c) ? cell ^ 1 : cell;
    }));
    writeFormat(grid, mask);
    writeVersion(grid, v);
    const score = penalty(grid);
    if (!best || score < best.score) best = { score, grid, mask };
  }

  return { size: best.grid.length, modules: best.grid, version: v, mask: best.mask };
}

// Whether a cell belongs to a function pattern, and so is never masked. Recomputed rather than
// remembered because blank() overwrites nulls with real values as it goes.
const functionMaps = new Map();
function isFunctionCell(version, r, c) {
  let map = functionMaps.get(version);
  if (!map) {
    const size = 17 + 4 * version;
    map = Array.from({ length: size }, () => new Array(size).fill(false));
    const mark = (top, left, h, w) => {
      for (let y = top; y < top + h; y++) {
        for (let x = left; x < left + w; x++) {
          if (y >= 0 && y < size && x >= 0 && x < size) map[y][x] = true;
        }
      }
    };
    mark(0, 0, 9, 9);
    mark(0, size - 8, 9, 8);
    mark(size - 8, 0, 8, 9);
    for (let i = 0; i < size; i++) { map[6][i] = true; map[i][6] = true; }
    const centres = ALIGN[version];
    for (const cy of centres) {
      for (const cx of centres) {
        const onFinder = (cy <= 8 && cx <= 8) || (cy <= 8 && cx >= size - 9) || (cy >= size - 9 && cx <= 8);
        if (!onFinder) mark(cy - 2, cx - 2, 5, 5);
      }
    }
    if (version >= 7) {
      mark(size - 11, 0, 3, 6);
      mark(0, size - 11, 6, 3);
    }
    functionMaps.set(version, map);
  }
  return map[r][c];
}

// An SVG string, which is what the browser actually wants. One path for every dark module beats one
// rect each: a version 3 code is 841 modules and 841 elements makes a phone think about it.
export function qrSvg(text, { scale = 8, quiet = 4, dark = '#000', light = '#fff' } = {}) {
  const { size, modules } = qr(text);
  const span = (size + quiet * 2) * scale;
  let d = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c] !== 1) continue;
      d += `M${(c + quiet) * scale} ${(r + quiet) * scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${span} ${span}" width="${span}" height="${span}" shape-rendering="crispEdges" role="img">`
    + `<rect width="${span}" height="${span}" fill="${light}"/>`
    + `<path d="${d}" fill="${dark}"/></svg>`;
}
