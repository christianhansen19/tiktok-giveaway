import test from 'node:test';
import assert from 'node:assert/strict';
import { rewards, entriesOf, aggregate, draw, giftToEvent } from '../server/logic.js';

const gift = (userId, coins, nickname = userId) => ({ type: 'gift', userId, nickname, coins });

test('ornaments for ONE gift at tier boundaries', () => {
  const r = (c) => Object.values(rewards(c)).join('');
  assert.equal(r(999), '000');
  assert.equal(r(1000), '100');
  assert.equal(r(4999), '100');
  assert.equal(r(5000), '110');
  assert.equal(r(9999), '110');
  assert.equal(r(10000), '111');
});

test('one 16,000-coin gift stacks small + medium + large', () => {
  assert.deepEqual(rewards(16000), { small: 1, medium: 1, large: 1 });
});

test('entries: 1 per small, 5 per medium, 10 per large', () => {
  assert.equal(entriesOf({ small: 1, medium: 0, large: 0 }), 1);
  assert.equal(entriesOf({ small: 1, medium: 1, large: 0 }), 6);
  assert.equal(entriesOf({ small: 1, medium: 1, large: 1 }), 16);
  assert.equal(entriesOf({ small: 2, medium: 0, large: 0 }), 2);
});

test('two separate 1,500 gifts = 2 small ornaments (not cumulative 3,000)', () => {
  const [row] = aggregate([gift('a', 1500), gift('a', 1500)]);
  assert.deepEqual(row.rewards, { small: 2, medium: 0, large: 0 });
  assert.equal(row.entries, 2);
  assert.equal(row.coins, 3000);
});

test('small gifts add coins but earn nothing, even when they add up past 1,000', () => {
  const [row] = aggregate([gift('a', 600), gift('a', 600), gift('a', 600)]);
  assert.deepEqual(row.rewards, { small: 0, medium: 0, large: 0 });
  assert.equal(row.entries, 0);
  assert.equal(row.coins, 1800);
});

test('a gift of exactly 10,000 earns all three and 16 entries', () => {
  const [row] = aggregate([gift('a', 10000)]);
  assert.deepEqual(row.rewards, { small: 1, medium: 1, large: 1 });
  assert.equal(row.entries, 16);
});

test('streak gifts only count when the streak ends, with full repeatCount', () => {
  const base = { user: { userId: '1', nickname: 'a' }, gift: { type: 1, diamondCount: 5, name: 'Rose' } };
  assert.equal(giftToEvent({ ...base, repeatCount: 3, repeatEnd: false }), null);
  assert.equal(giftToEvent({ ...base, repeatCount: 10, repeatEnd: true }).coins, 50);
});

test('a streak counts as ONE gift at its total (5 x 300 = one 1,500 gift = 1 small)', () => {
  const base = { user: { userId: '1', nickname: 'a' }, gift: { type: 1, diamondCount: 300, name: 'Gift' } };
  const e = giftToEvent({ ...base, repeatCount: 5, repeatEnd: 1 });
  assert.equal(e.coins, 1500);
  assert.deepEqual(aggregate([e])[0].rewards, { small: 1, medium: 0, large: 0 });
});

test('current connector shape: price lives in data.gift, repeatEnd is 0/1', () => {
  const msg = { giftId: '5655', repeatCount: 1, user: { userId: '7675183019858723853', nickname: 'goatedfrfr' }, gift: { type: 1, diamondCount: 1, name: 'Rose' } };
  assert.equal(giftToEvent({ ...msg, repeatEnd: 0 }), null);
  const e = giftToEvent({ ...msg, repeatEnd: 1 });
  assert.equal(e.coins, 1);
  assert.equal(e.giftName, 'Rose');
  assert.equal(e.userId, '7675183019858723853');
  const galaxy = giftToEvent({ ...msg, gift: { type: 2, diamondCount: 1000, name: 'Galaxy' }, repeatEnd: 0 });
  assert.equal(galaxy.coins, 1000);
});

test('manual adjust: positive adds one gift of that size, negative removes one', () => {
  const add = aggregate([gift('a', 600), { type: 'adjust', userId: 'a', coins: 1500 }])[0];
  assert.deepEqual(add.rewards, { small: 1, medium: 0, large: 0 });
  const undone = aggregate([gift('a', 1500), gift('a', 1500), { type: 'adjust', userId: 'a', coins: -1500 }])[0];
  assert.deepEqual(undone.rewards, { small: 1, medium: 0, large: 0 });
  assert.equal(undone.coins, 1500);
});

test('board ranks by entries, then coins; excluded users are on the board but not in the pool', () => {
  const b = aggregate([gift('a', 6000), gift('b', 1500), gift('b', 1500), gift('host', 20000), gift('c', 900)], new Set(['host']));
  assert.deepEqual(b.map((r) => r.userId), ['host', 'a', 'b', 'c']); // 16, 6, 2, 0 entries
  assert.equal(b[0].eligible, false);
  assert.equal(b[0].odds, 0);
  assert.ok(Math.abs(b[1].odds - 6 / 8) < 1e-9); // pool = a(6) + b(2)
  assert.equal(b[3].odds, 0);
});

test('draw is deterministic for a seed and matches entry share over many draws', () => {
  // a: one 16,000 gift = 16 entries; b: 5,000 gift = 6 entries; c: 1,000 gift = 1 entry; d: 900 = 0 entries
  const board = aggregate([gift('a', 16000), gift('b', 5000), gift('c', 1000), gift('d', 900)]);
  assert.equal(draw(board, 'x').winner.userId, draw(board, 'x').winner.userId);
  const N = 20000;
  const wins = { a: 0, b: 0, c: 0, d: 0 };
  for (let i = 0; i < N; i++) wins[draw(board, `seed-${i}`).winner.userId]++;
  const total = 16 + 6 + 1;
  assert.equal(wins.d, 0, 'viewer with no entries can never win');
  assert.ok(Math.abs(wins.a / N - 16 / total) < 0.02, `a=${wins.a / N}`);
  assert.ok(Math.abs(wins.b / N - 6 / total) < 0.02, `b=${wins.b / N}`);
  assert.ok(Math.abs(wins.c / N - 1 / total) < 0.02, `c=${wins.c / N}`);
});

test('draw returns null when nobody has entries', () => {
  assert.equal(draw(aggregate([gift('a', 500)]), 's'), null);
});
