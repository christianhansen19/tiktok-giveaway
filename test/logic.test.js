import test from 'node:test';
import assert from 'node:assert/strict';
import { rewards, aggregate, draw, giftToEvent } from '../server/logic.js';

test('rewards at tier boundaries', () => {
  const r = (c) => Object.values(rewards(c)).join('');
  assert.equal(r(999), '000');
  assert.equal(r(1000), '100');
  assert.equal(r(4999), '100');
  assert.equal(r(5000), '110');
  assert.equal(r(9999), '110');
  assert.equal(r(10000), '111');
});

test('16,000 coins stacks one of each ornament', () => {
  assert.deepEqual(rewards(16000), { small: 1, medium: 1, large: 1 });
});

test('streak gifts only count when the streak ends, with full repeatCount', () => {
  const base = { user: { userId: '1', nickname: 'a' }, giftDetails: { giftType: 1, diamondCount: 5, giftName: 'Rose' } };
  assert.equal(giftToEvent({ ...base, repeatCount: 3, repeatEnd: false }), null);
  assert.equal(giftToEvent({ ...base, repeatCount: 10, repeatEnd: true }).coins, 50);
});

test('non-streak gift counts immediately', () => {
  const e = giftToEvent({ user: { userId: '2', nickname: 'b' }, giftDetails: { giftType: 2, diamondCount: 1000 }, repeatCount: 1, repeatEnd: false });
  assert.equal(e.coins, 1000);
});

test('aggregate sums per user, honours adjustments, flags exclusions', () => {
  const ev = [
    { type: 'gift', userId: '1', nickname: 'a', coins: 600 },
    { type: 'gift', userId: '1', nickname: 'a', coins: 500 },
    { type: 'gift', userId: '2', nickname: 'host', coins: 300 },
    { type: 'adjust', userId: '1', nickname: 'a', coins: -100 },
  ];
  const b = aggregate(ev, new Set(['2']));
  assert.equal(b[0].coins, 1000);
  assert.deepEqual(b[0].rewards, { small: 1, medium: 0, large: 0 });
  assert.equal(b[1].eligible, false);
  assert.equal(b[0].odds, 1); // excluded user removed from pool
});

test('draw is deterministic for a seed and matches coin share over many draws', () => {
  const board = aggregate([
    { type: 'gift', userId: 'a', nickname: 'a', coins: 7000 },
    { type: 'gift', userId: 'b', nickname: 'b', coins: 2000 },
    { type: 'gift', userId: 'c', nickname: 'c', coins: 1000 },
  ]);
  assert.equal(draw(board, 'x').winner.userId, draw(board, 'x').winner.userId);
  const N = 10000;
  const wins = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < N; i++) wins[draw(board, `seed-${i}`).winner.userId]++;
  assert.ok(Math.abs(wins.a / N - 0.7) < 0.02, `a=${wins.a / N}`);
  assert.ok(Math.abs(wins.b / N - 0.2) < 0.02, `b=${wins.b / N}`);
  assert.ok(Math.abs(wins.c / N - 0.1) < 0.02, `c=${wins.c / N}`);
});
