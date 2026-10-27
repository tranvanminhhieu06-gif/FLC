'use strict';
process.env.FLC_DB = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLines, validateRates } = require('../src/services/commission');
const { DEFAULT_RATES } = require('../src/lib/labels');

const sum = (lines) => lines.reduce((s, l) => s + l.amount, 0);
const holders = {
  REFERRER: [{ userId: 1, shareBp: 10000 }],
  SALES: [{ userId: 2, shareBp: 10000 }],
  ACCOUNT: [{ userId: 3, shareBp: 10000 }],
  PM: [{ userId: 4, shareBp: 10000 }],
  PROJECT: [{ userId: 5, shareBp: 6000 }, { userId: 6, shareBp: 4000 }],
};

test('tổng các dòng luôn bằng đúng doanh thu thuần (kể cả số lẻ)', () => {
  for (const net of [1, 7, 999, 18181818, 33333333, 100000001]) {
    assert.equal(sum(computeLines({ net, allocations: DEFAULT_RATES, holders, needsPm: true })), net);
  }
});

test('không có Referrer → phần Referrer về M&T, không chia cho người khác', () => {
  const { REFERRER, ...rest } = holders;
  const lines = computeLines({ net: 10_000_000, allocations: DEFAULT_RATES, holders: rest, needsPm: true });
  const ref = lines.find((l) => l.role === 'REFERRER');
  assert.equal(ref.beneficiary, 'MT');
  assert.equal(ref.userId, null);
  assert.equal(ref.amount, 500_000);
  assert.equal(lines.filter((l) => l.userId === 2).reduce((s, l) => s + l.amount, 0), 1_000_000, 'Sales không nhận thêm');
});

test('không có PM → Account nhận phần PM thành dòng riêng', () => {
  const lines = computeLines({ net: 10_000_000, allocations: DEFAULT_RATES, holders, needsPm: false });
  const pm = lines.find((l) => l.role === 'PM');
  assert.equal(pm.userId, 3);
  assert.match(pm.reason, /Account kiêm PM/);
  assert.equal(lines.some((l) => l.userId === 4), false, 'PM được mời nhưng Order không cần PM thì không nhận');
});

test('nhiều Project chia theo tỷ lệ phân công', () => {
  const lines = computeLines({ net: 10_000_000, allocations: DEFAULT_RATES, holders, needsPm: true });
  assert.equal(lines.find((l) => l.userId === 5).amount, 3_000_000);
  assert.equal(lines.find((l) => l.userId === 6).amount, 2_000_000);
});

test('một người nhiều vai trò: mỗi vai trò một dòng, không trùng (beneficiary, role)', () => {
  const same = { ...holders, SALES: [{ userId: 1, shareBp: 10000 }] }; // Referrer kiêm Sales
  const lines = computeLines({ net: 10_000_000, allocations: DEFAULT_RATES, holders: same, needsPm: true });
  const mine = lines.filter((l) => l.userId === 1);
  assert.deepEqual(mine.map((l) => l.role).sort(), ['REFERRER', 'SALES']);
  const keys = lines.map((l) => `${l.beneficiary}|${l.role}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('hoàn tiền (net âm) sinh dòng điều chỉnh âm, tổng vẫn khớp', () => {
  const lines = computeLines({ net: -5_000_000, allocations: DEFAULT_RATES, holders, needsPm: true });
  assert.equal(sum(lines), -5_000_000);
  assert.ok(lines.filter((l) => l.userId).every((l) => l.amount <= 0));
});

test('tỷ lệ phải cộng đủ 100%', () => {
  assert.doesNotThrow(() => validateRates(DEFAULT_RATES));
  assert.throws(() => validateRates({ ...DEFAULT_RATES, MT: 1400 }), /100%/);
});
