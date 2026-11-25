import test from 'node:test';
import assert from 'node:assert/strict';
import { rewards, entriesOf, aggregate, draw, giftToEvent, buildQueue } from '../server/logic.js';

const gift = (userId, coins, nickname = userId) => ({ type: 'gift', userId, nickname, coins });
const sizes = (r) => `${r.large}L ${r.medium}M ${r.small}S`;

test('a gift is split by value, biggest first (large 10,000 / medium 5,000 / small 1,000)', () => {
  const cases = {
    999: '0L 0M 0S',
    1000: '0L 0M 1S',
    1500: '0L 0M 1S',
    2500: '0L 0M 2S',
    4999: '0L 0M 4S',
    5000: '0L 1M 0S',
    7000: '0L 1M 2S',
    9000: '0L 1M 4S',
    9999: '0L 1M 4S',
    10000: '1L 0M 0S',
    12000: '1L 0M 2S',
    16000: '1L 1M 1S',
    25000: '2L 1M 0S',
  };
  for (const [coins, want] of Object.entries(cases)) assert.equal(sizes(rewards(Number(coins))), want, `${coins} coins`);
});

test('12,000-coin gift = 1 large + 2 small (not a medium)', () => {
  assert.deepEqual(rewards(12000), { small: 2, medium: 0, large: 1 });
});

test('entries: 1 per small, 5 per medium, 10 per large = 1 per 1,000 coins of ornament value', () => {
  assert.equal(entriesOf({ small: 1, medium: 0, large: 0 }), 1);
  assert.equal(entriesOf({ small: 1, medium: 1, large: 1 }), 16);
  assert.equal(entriesOf(rewards(12000)), 12);
  assert.equal(entriesOf(rewards(16000)), 16);
  assert.equal(entriesOf(rewards(1500)), 1);
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

test('a gift of exactly 10,000 is one large (10 entries)', () => {
  const [row] = aggregate([gift('a', 10000)]);
  assert.deepEqual(row.rewards, { small: 0, medium: 0, large: 1 });
  assert.equal(row.entries, 10);
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
  const big = aggregate([gift('a', 12000), { type: 'adjust', userId: 'a', coins: -12000 }]);
  assert.equal(big.length, 0); // coins back to 0, nothing left
});

test('board ranks by entries, then coins; excluded users are on the board but not in the pool', () => {
  // host 20,000 = 20 entries; a 6,000 = 1M+1S = 6; b two 1,500 = 2; c 900 = 0
  const b = aggregate([gift('a', 6000), gift('b', 1500), gift('b', 1500), gift('host', 20000), gift('c', 900)], new Set(['host']));
  assert.deepEqual(b.map((r) => r.userId), ['host', 'a', 'b', 'c']);
  assert.equal(b[0].eligible, false);
  assert.equal(b[0].odds, 0);
  assert.ok(Math.abs(b[1].odds - 6 / 8) < 1e-9); // pool = a(6) + b(2)
  assert.equal(b[3].odds, 0);
});

test('draw is deterministic for a seed and matches entry share over many draws', () => {
  // a: 16,000 = 16 entries; b: 5,000 = 5; c: 1,000 = 1; d: 900 = 0
  const board = aggregate([gift('a', 16000), gift('b', 5000), gift('c', 1000), gift('d', 900)]);
  assert.equal(draw(board, 'x').winner.userId, draw(board, 'x').winner.userId);
  const N = 20000;
  const wins = { a: 0, b: 0, c: 0, d: 0 };
  for (let i = 0; i < N; i++) wins[draw(board, `seed-${i}`).winner.userId]++;
  const total = 16 + 5 + 1;
  assert.equal(wins.d, 0, 'viewer with no entries can never win');
  assert.ok(Math.abs(wins.a / N - 16 / total) < 0.02, `a=${wins.a / N}`);
  assert.ok(Math.abs(wins.b / N - 5 / total) < 0.02, `b=${wins.b / N}`);
  assert.ok(Math.abs(wins.c / N - 1 / total) < 0.02, `c=${wins.c / N}`);
});

test('draw returns null when nobody has entries', () => {
  assert.equal(draw(aggregate([gift('a', 500)]), 's'), null);
});

// ---- ornament queue ----
const start = { type: 'start', ts: 0 };
const g = (userId, coins, ts, nickname = userId) => ({ type: 'gift', userId, nickname, coins, ts });

test('queue: 12,000 gift = 3 rows (2 small + 1 large) with unique ids', () => {
  const q = buildQueue([start, g('a', 12000, 1)]);
  assert.deepEqual(q.map((i) => i.size), ['small', 'small', 'large']);
  assert.equal(new Set(q.map((i) => i.id)).size, 3);
});

test('queue: 16,000 gift = small, medium, large; sub-1,000 gifts add none', () => {
  const q = buildQueue([start, g('a', 16000, 1), g('a', 900, 2)]);
  assert.deepEqual(q.map((i) => i.size), ['small', 'medium', 'large']);
  assert.ok(q.every((i) => i.userId === 'a' && !i.done));
});

test('queue: two 1,500 gifts = 2 small items, oldest first', () => {
  const q = buildQueue([start, g('a', 1500, 1), g('b', 1500, 2), g('a', 1500, 3)]);
  assert.deepEqual(q.map((i) => [i.userId, i.ts]), [['a', 1], ['b', 2], ['a', 3]]);
});

test('queue: only items after the latest start', () => {
  const q = buildQueue([start, g('a', 1500, 1), { type: 'stop', ts: 2 }, { type: 'start', ts: 3 }, g('b', 1500, 4)]);
  assert.deepEqual(q.map((i) => i.userId), ['b']);
  assert.deepEqual(buildQueue([g('a', 1500, 1)]), []); // no start yet
});

test('queue: check and uncheck, last event wins; later events do not change ids', () => {
  const log = [start, g('a', 1500, 1), g('b', 1500, 2)];
  const [first] = buildQueue(log);
  const checked = [...log, { type: 'ornament_check', itemId: first.id, done: true }];
  assert.deepEqual(buildQueue(checked).map((i) => i.done), [true, false]);
  const undone = [...checked, { type: 'ornament_check', itemId: first.id, done: false }];
  assert.deepEqual(buildQueue(undone).map((i) => i.done), [false, false]);
  const more = [...checked, g('c', 5000, 9)];
  assert.equal(buildQueue(more)[0].id, first.id); // ids stable as the log grows
});

test('queue: checking one of two identical smalls only ticks that one', () => {
  const log = [start, g('a', 2500, 1)];
  const [s1, s2] = buildQueue(log);
  const q = buildQueue([...log, { type: 'ornament_check', itemId: s2.id, done: true }]);
  assert.deepEqual(q.map((i) => [i.id === s1.id, i.done]), [[true, false], [false, true]]);
});

test('queue: negative adjust removes the latest unwritten ornaments of that gift', () => {
  const log = [start, g('a', 1500, 1), g('a', 1500, 2), { type: 'adjust', userId: 'a', coins: -1500, ts: 3 }];
  const q = buildQueue(log);
  assert.equal(q.length, 1);
  assert.equal(q[0].ts, 1); // the newer one was cancelled
  const big = buildQueue([start, g('a', 12000, 1), { type: 'adjust', userId: 'a', coins: -12000, ts: 2 }]);
  assert.equal(big.length, 0);
});

test('queue: negative adjust never cancels an ornament that is already written', () => {
  const base = [start, g('a', 1500, 1)];
  const [it] = buildQueue(base);
  const log = [...base, { type: 'ornament_check', itemId: it.id, done: true }, { type: 'adjust', userId: 'a', coins: -1500, ts: 3 }];
  const q = buildQueue(log);
  assert.equal(q.length, 1);
  assert.equal(q[0].done, true);
});
