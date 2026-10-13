import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// The dashboard ships plain browser JavaScript from packages/server/ui; these tests load it directly.
// @ts-expect-error no type declarations for the browser module
import { dataCodewords, maxBytes, qrMatrix, rawCodewords } from '../ui/qr.js';
// @ts-expect-error no type declarations for the browser module
import { formatUnits, shortId, statusLabel } from '../ui/util.js';

const hashOf = (m: { modules: boolean[][] }) =>
  createHash('sha256')
    .update(m.modules.map((r) => r.map((d) => (d ? '1' : '0')).join('')).join('\n'))
    .digest('hex');

describe('QR encoder: capacity tables', () => {
  it('matches the published ISO 18004 data capacities for versions 1-6', () => {
    // [version, L, M, Q, H] data codewords. A wrong table entry here would silently corrupt symbols.
    const published: Array<[number, number, number, number, number]> = [
      [1, 19, 16, 13, 9],
      [2, 34, 28, 22, 16],
      [3, 55, 44, 34, 26],
      [4, 80, 64, 48, 36],
      [5, 108, 86, 62, 46],
      [6, 136, 108, 76, 60],
    ];
    for (const [v, l, m, q, h] of published) {
      expect([dataCodewords(v, 'L'), dataCodewords(v, 'M'), dataCodewords(v, 'Q'), dataCodewords(v, 'H')], `v${v}`).toEqual([l, m, q, h]);
    }
    expect([1, 2, 3, 4, 5, 6].map(rawCodewords)).toEqual([26, 44, 70, 100, 134, 172]);
  });
});

describe('QR encoder: symbols', () => {
  // Golden hashes of matrices that were compared module-for-module against an independent reference
  // implementation (qrcode@1.5.4) for every mask and error-correction level, with zero differences.
  it.each([
    ['TEoTebyMy4eF2auGyRj1kDB7MTWarUP8AK', 'M', 3, 3, 'efab26455f4eba4fef184990cf9cfd906d0a4c48f045ed3d370d183f81012b74'],
    ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 'L', 5, 3, '5c6c1f6167ceb416a0e0d7eaba07d991ba3faff98389f14338dd384e25208dc6'],
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'Q', 0, 4, '6a1901a950b9d06b0a89e65e11650b5c16ddc3393c78e576ab5a16f032926423'],
    ['HELLO WORLD', 'H', 7, 2, 'e951e9b2877dc48b6e87f6bf3df3d617561f1a012052745ce31606ef8211a4f1'],
    ['A', 'M', 1, 1, '43f688a881761c91722f6a5b0cd903151091c3ebca0ddc94d636e65072abae1a'],
    ['x'.repeat(100), 'L', 4, 5, 'bde8b7726de0f774f82461be431ca9dc85878d38851bd462777fba89fc8600df'],
  ])('encodes %s at level %s, mask %i, to the verified matrix', (text, ecc, mask, version, hash) => {
    const m = qrMatrix(text, { ecc, mask });
    expect(m.version).toBe(version);
    expect(m.size).toBe(version * 4 + 17);
    expect(hashOf(m)).toBe(hash);
  });

  it('draws finder, timing and dark-module function patterns correctly', () => {
    const { modules, size } = qrMatrix('TEoTebyMy4eF2auGyRj1kDB7MTWarUP8AK');
    for (const [ox, oy] of [[0, 0], [size - 7, 0], [0, size - 7]] as const) {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          expect(modules[oy + y]![ox + x], `finder (${ox},${oy}) @${x},${y}`).toBe(ring !== 2);
        }
      }
    }
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]![8]).toBe(true);
  });

  it('picks the smallest version that fits, and a higher level needs a larger one', () => {
    expect(qrMatrix('A', { ecc: 'L' }).version).toBe(1);
    const addr = 'TEoTebyMy4eF2auGyRj1kDB7MTWarUP8AK'; // 34 bytes
    expect(qrMatrix(addr, { ecc: 'L' }).version).toBeLessThanOrEqual(qrMatrix(addr, { ecc: 'H' }).version);
  });

  it('is deterministic, and handles UTF-8 by byte length', () => {
    expect(hashOf(qrMatrix('₦1,500'))).toBe(hashOf(qrMatrix('₦1,500')));
    expect(qrMatrix('₦'.repeat(40), { ecc: 'L' }).version).toBeGreaterThan(qrMatrix('N'.repeat(40), { ecc: 'L' }).version); // 3 bytes each
  });

  it('refuses text that does not fit, instead of emitting a broken symbol', () => {
    const limit = maxBytes('M');
    expect(() => qrMatrix('x'.repeat(limit), { ecc: 'M' })).not.toThrow();
    expect(() => qrMatrix('x'.repeat(limit + 1), { ecc: 'M' })).toThrow(/Too long/);
  });

  it('rejects unknown levels and masks', () => {
    expect(() => qrMatrix('a', { ecc: 'Z' })).toThrow(/level/);
    expect(() => qrMatrix('a', { mask: 8 })).toThrow(/mask/);
  });
});

describe('dashboard formatting helpers', () => {
  it('formats minor units exactly, with no float rounding', () => {
    expect(formatUnits('2982069', 6)).toBe('2.982069');
    expect(formatUnits('2982100', 6)).toBe('2.9821');
    expect(formatUnits('420000', 2, { minFraction: 2 })).toBe('4,200.00');
    expect(formatUnits('1', 18)).toBe('0.000000000000000001');
    expect(formatUnits('123456789012345678901234567890', 6)).toBe('123,456,789,012,345,678,901,234.56789');
    expect(formatUnits('0', 6)).toBe('0');
    expect(formatUnits('-1500', 2, { minFraction: 2 })).toBe('-15.00');
    expect(formatUnits('5', 0)).toBe('5');
  });

  it('shows an unexpected value unchanged instead of inventing a number', () => {
    expect(formatUnits('abc', 6)).toBe('abc');
    expect(formatUnits('1.5', 6)).toBe('1.5');
  });

  it('shortens ids and labels statuses', () => {
    expect(shortId('pay_a17019cda1876e71b6c53fca')).toBe('pay_a17019…3fca');
    expect(shortId('pay_1')).toBe('pay_1');
    expect(statusLabel('refund_required')).toBe('Refund required');
  });
});
