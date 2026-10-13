// Minimal QR Code encoder for the dashboard: byte mode, versions 1-6, error correction L/M/Q/H.
//
// Written in-house so the payments UI ships no third-party script. It is small on purpose (versions 1-6 hold up
// to ~134 bytes, plenty for a deposit address or a payment URI, and avoid the version-information block that
// only appears from version 7). Follows ISO/IEC 18004. Verified against an independent implementation for every
// mask and error-correction level; see packages/server/test/qr.test.ts.

const ECC = { L: { fmt: 1, row: 0 }, M: { fmt: 0, row: 1 }, Q: { fmt: 3, row: 2 }, H: { fmt: 2, row: 3 } };
// Indexed [level row][version - 1].
const ECC_CODEWORDS_PER_BLOCK = [
  [7, 10, 15, 20, 26, 18],
  [10, 16, 26, 18, 24, 16],
  [13, 22, 18, 26, 18, 24],
  [17, 28, 22, 16, 22, 28],
];
const NUM_BLOCKS = [
  [1, 1, 1, 1, 1, 2],
  [1, 1, 1, 2, 2, 4],
  [1, 1, 2, 2, 4, 4],
  [1, 1, 2, 4, 4, 4],
];
export const MAX_VERSION = 6;

/** Total codewords (data + error correction) a version holds. */
export function rawCodewords(version) {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    bits -= (25 * align - 10) * align - 55;
  }
  return Math.floor(bits / 8);
}

/** Codewords available for data at an error-correction level. */
export function dataCodewords(version, level) {
  const row = ECC[level].row;
  return rawCodewords(version) - ECC_CODEWORDS_PER_BLOCK[row][version - 1] * NUM_BLOCKS[row][version - 1];
}

/** Largest byte-mode payload that fits (version 6) at a level. */
export function maxBytes(level) {
  return Math.floor((dataCodewords(MAX_VERSION, level) * 8 - 12) / 8);
}

// ---- Reed-Solomon over GF(2^8), primitive polynomial 0x11D

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMul(coef, factor);
    });
  }
  return result;
}

function addEccAndInterleave(data, version, row) {
  const numBlocks = NUM_BLOCKS[row][version - 1];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[row][version - 1];
  const raw = rawCodewords(version);
  const numShort = numBlocks - (raw % numBlocks);
  const shortLen = Math.floor(raw / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let b = 0, k = 0; b < numBlocks; b++) {
    const len = shortLen - blockEccLen + (b < numShort ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const ecc = rsRemainder(dat, divisor);
    if (b < numShort) dat.push(0); // keeps blocks the same length; skipped below when interleaving
    blocks.push(dat.concat(ecc));
  }
  const out = [];
  for (let c = 0; c < blocks[0].length; c++) {
    blocks.forEach((blk, b) => {
      if (c !== shortLen - blockEccLen || b >= numShort) out.push(blk[c]);
    });
  }
  return out;
}

// ---- Mask patterns and scoring

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function lineScore(get, size) {
  let score = 0;
  let run = 1;
  for (let i = 1; i < size; i++) {
    if (get(i) === get(i - 1)) {
      run++;
      if (run === 5) score += 3;
      else if (run > 5) score += 1;
    } else run = 1;
  }
  // Finder-like 1:1:3:1:1 runs with light space beside them. The symbol edge counts as light.
  const line = [0, 0, 0, 0, 0];
  for (let i = 0; i < size; i++) line.push(get(i) ? 1 : 0);
  line.push(0, 0, 0, 0, 0);
  const A = [0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]; // light, core, 4 light after
  const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1, 0]; // 4 light before, core, light
  for (let i = 0; i + 12 <= line.length; i++) {
    if (A.every((v, j) => line[i + j] === v)) score += 40;
    if (B.every((v, j) => line[i + j] === v)) score += 40;
  }
  return score;
}

function penalty(m, size) {
  let score = 0;
  for (let y = 0; y < size; y++) score += lineScore((i) => m[y][i], size);
  for (let x = 0; x < size; x++) score += lineScore((i) => m[i][x], size);
  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (m[y][x]) dark++;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }
  const total = size * size;
  score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return score;
}

/**
 * Encodes `text` (UTF-8, byte mode) as a QR symbol.
 * `options.ecc` is L, M (default), Q or H; `options.mask` (0-7) forces a mask, otherwise the lowest-penalty one is used.
 * Returns `{ version, size, ecc, mask, modules }` where `modules[y][x]` is true for a dark module.
 */
export function qrMatrix(text, options = {}) {
  const level = options.ecc ?? 'M';
  if (!ECC[level]) throw new Error(`Unknown error-correction level "${level}"`);
  if (options.mask !== undefined && !(Number.isInteger(options.mask) && options.mask >= 0 && options.mask <= 7)) throw new Error('mask must be an integer from 0 to 7');
  const row = ECC[level].row;
  const bytes = new TextEncoder().encode(String(text));

  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (4 + 8 + 8 * bytes.length <= dataCodewords(v, level) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error(`Too long for a QR code here: ${bytes.length} bytes, at most ${maxBytes(level)} at level ${level}`);

  // Bit stream: mode 0100 (byte), 8-bit length, payload, terminator, padding.
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacityBits = dataCodewords(version, level) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }
  const codewords = addEccAndInterleave(data, version, row);

  // Function patterns.
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  for (let i = 0; i < size; i++) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  if (version >= 2) {
    const c = size - 7; // the single alignment pattern for versions 2-6
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(c + dx, c + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }

  const drawFormat = (mask) => {
    const d = (ECC[level].fmt << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = ((d << 10) | rem) ^ 0x5412;
    const bit = (i) => ((fmt >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6));
    setFn(8, 8, bit(7));
    setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true); // the always-dark module
  };
  drawFormat(0); // reserves the format areas so data skips them

  // Data bits, zig-zagging up and down two-column strips from the bottom right.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex++;
        }
      }
    }
  }

  const applyMask = (mask) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  };
  let mask = options.mask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const p = penalty(modules, size);
      if (p < best) {
        best = p;
        mask = m;
      }
      applyMask(m); // undo
    }
  }
  applyMask(mask);
  drawFormat(mask);
  return { version, size, ecc: level, mask, modules };
}
