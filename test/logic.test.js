import test from 'node:test';
import assert from 'node:assert/strict';
import { rewards, giftEntries, aggregate, draw, giftToEvent, buildQueue, findViewers } from '../server/logic.js';

const gift = (userId, coins, nickname = userId) => ({ type: 'gift', userId, nickname, coins });
const orn = (r) => `${r.large}L ${r.medium}M`;

test('one gift: nothing under 1,000; medium 1,000-9,999; large 10,000+; never more than one ornament', () => {
  const cases = { 1: '0L 0M', 500: '0L 0M', 999: '0L 0M', 1000: '0L 1M', 1500: '0L 1M', 9999: '0L 1M', 10000: '1L 0M', 12000: '1L 0M', 15000: '1L 0M', 25000: '1L 0M' };
  for (const [coins, want] of Object.entries(cases)) assert.equal(orn(rewards(Number(coins))), want, `${coins} coins`);
});

test('entries per gift: 1 per 1,000 coins rounded down, none under 1,000', () => {
  const cases = { 500: 0, 999: 0, 1000: 1, 1500: 1, 2500: 2, 9999: 9, 10000: 10, 15000: 15, 15500: 15 };
  for (const [coins, want] of Object.entries(cases)) assert.equal(giftEntries(Number(coins)), want, `${coins} coins`);
});

test('15,000 gift = ONE large ornament but 15 entries', () => {
  const [row] = aggregate([gift('a', 15000)]);
  assert.deepEqual(row.rewards, { medium: 0, large: 1 });
  assert.equal(row.entries, 15);
});

test('two 500-coin gifts count for nothing (small gifts never add up)', () => {
  const [row] = aggregate([gift('a', 500), gift('a', 500)]);
  assert.deepEqual(row.rewards, { medium: 0, large: 0 });
  assert.equal(row.entries, 0);
  assert.equal(row.coins, 1000); // still shown as coins sent
});

test('two separate 1,500 gifts = 2 medium ornaments and 2 entries', () => {
  const [row] = aggregate([gift('a', 1500), gift('a', 1500)]);
  assert.deepEqual(row.rewards, { medium: 2, large: 0 });
  assert.equal(row.entries, 2);
});

test('mixed gifts: entries only from qualifying gifts', () => {
  const [row] = aggregate([gift('a', 600), gift('a', 3000), gift('a', 12000), gift('a', 900)]);
  assert.deepEqual(row.rewards, { medium: 1, large: 1 });
  assert.equal(row.entries, 3 + 12);
  assert.equal(row.coins, 600 + 3000 + 12000 + 900);
});

test('streak gifts only count when the streak ends, with full repeatCount', () => {
  const base = { user: { userId: '1', nickname: 'a' }, gift: { type: 1, diamondCount: 5, name: 'Rose' } };
  assert.equal(giftToEvent({ ...base, repeatCount: 3, repeatEnd: false }), null);
  assert.equal(giftToEvent({ ...base, repeatCount: 10, repeatEnd: true }).coins, 50);
});

test('a streak counts as ONE gift at its total (5 x 300 = one 1,500 gift = 1 medium, 1 entry)', () => {
  const base = { user: { userId: '1', nickname: 'a' }, gift: { type: 1, diamondCount: 300, name: 'Gift' } };
  const e = giftToEvent({ ...base, repeatCount: 5, repeatEnd: 1 });
  assert.equal(e.coins, 1500);
  const [row] = aggregate([e]);
  assert.deepEqual(row.rewards, { medium: 1, large: 0 });
  assert.equal(row.entries, 1);
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

test('manual adjust: positive adds one gift of that value, negative removes one', () => {
  const add = aggregate([gift('a', 600), { type: 'adjust', userId: 'a', coins: 1500 }])[0];
  assert.deepEqual(add.rewards, { medium: 1, large: 0 });
  assert.equal(add.entries, 1);
  const undone = aggregate([gift('a', 1500), gift('a', 1500), { type: 'adjust', userId: 'a', coins: -1500 }])[0];
  assert.deepEqual(undone.rewards, { medium: 1, large: 0 });
  assert.equal(undone.entries, 1);
  assert.equal(undone.coins, 1500);
  assert.equal(aggregate([gift('a', 12000), { type: 'adjust', userId: 'a', coins: -12000 }]).length, 0);
});

test('board ranks by entries, then coins; excluded users are on the board but not in the pool', () => {
  // host 20 entries; a 6,000 = 6; b two 1,500 = 2; c 900 = 0
  const b = aggregate([gift('a', 6000), gift('b', 1500), gift('b', 1500), gift('host', 20000), gift('c', 900)], new Set(['host']));
  assert.deepEqual(b.map((r) => r.userId), ['host', 'a', 'b', 'c']);
  assert.equal(b[0].eligible, false);
  assert.equal(b[0].odds, 0);
  assert.ok(Math.abs(b[1].odds - 6 / 8) < 1e-9); // pool = a(6) + b(2)
  assert.equal(b[3].odds, 0);
});

test('draw is deterministic for a seed and matches entry share over many draws', () => {
  // a: 16,000 = 16; b: 5,000 = 5; c: 1,000 = 1; d: 900 = 0
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
  assert.equal(draw(aggregate([gift('a', 500), gift('a', 500)]), 's'), null);
});

// ---- ornament queue ----
const start = { type: 'start', ts: 0 };
const g = (userId, coins, ts, nickname = userId) => ({ type: 'gift', userId, nickname, coins, ts });

test('queue: one row per qualifying gift; 15,000 = one large row; small gifts add none', () => {
  const q = buildQueue([start, g('a', 15000, 1), g('a', 900, 2), g('a', 500, 3), g('a', 2000, 4)]);
  assert.deepEqual(q.map((i) => i.size), ['large', 'medium']);
  assert.ok(q.every((i) => i.userId === 'a' && !i.done));
});

test('queue: two 1,500 gifts = 2 medium rows, oldest first', () => {
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
  assert.equal(buildQueue(more)[0].id, first.id);
});

test('queue: legacy check-offs (old "<pos>-small/-medium/-large" ids) mark that gift written', () => {
  const log = [start, g('a', 12000, 1), g('b', 1500, 2), g('c', 1500, 3)];
  const withLegacy = [...log,
    { type: 'ornament_check', itemId: '1-small', done: true },   // a's gift, old small
    { type: 'ornament_check', itemId: '2-small', done: true },   // b's gift, ticked...
    { type: 'ornament_check', itemId: '2-small', done: false }]; // ...then un-ticked
  const q = buildQueue(withLegacy);
  assert.deepEqual(q.map((i) => [i.userId, i.done]), [['a', true], ['b', false], ['c', false]]);
  // an explicit new-style un-tick overrides a legacy tick
  const q2 = buildQueue([...withLegacy, { type: 'ornament_check', itemId: '1', done: false }]);
  assert.equal(q2[0].done, false);
});

test('queue: negative adjust removes the latest unwritten item of that size for that viewer', () => {
  const log = [start, g('a', 1500, 1), g('a', 1500, 2), { type: 'adjust', userId: 'a', coins: -1500, ts: 3 }];
  const q = buildQueue(log);
  assert.equal(q.length, 1);
  assert.equal(q[0].ts, 1);
  assert.equal(buildQueue([start, g('a', 12000, 1), { type: 'adjust', userId: 'a', coins: -12000, ts: 2 }]).length, 0);
});

test('queue: negative adjust never cancels an ornament that is already written', () => {
  const base = [start, g('a', 1500, 1)];
  const [it] = buildQueue(base);
  const log = [...base, { type: 'ornament_check', itemId: it.id, done: true }, { type: 'adjust', userId: 'a', coins: -1500, ts: 3 }];
  const q = buildQueue(log);
  assert.equal(q.length, 1);
  assert.equal(q[0].done, true);
});

// ---- ranking and search ----
test('only viewers with entries get a rank; others are unranked but still listed', () => {
  const rows = aggregate([gift('a', 600), gift('b', 3000), gift('c', 1000), gift('d', 900)]);
  assert.deepEqual(rows.map((r) => [r.userId, r.rank]), [['b', 1], ['c', 2], ['d', null], ['a', null]]);
});

test('findViewers: case-insensitive partial match, ranked viewers first, limit, min 2 letters', () => {
  const rows = aggregate([gift('1', 5000, 'Matt Smith'), gift('2', 700, 'matty'), gift('3', 2000, 'MATTHEW'), gift('4', 9000, 'Zed')]);
  assert.deepEqual(findViewers(rows, 'MATT').map((r) => r.userId), ['1', '3', '2']);
  assert.deepEqual(findViewers(rows, 'matt', 2).map((r) => r.userId), ['1', '3']);
  assert.deepEqual(findViewers(rows, 'm'), []); // too short
  assert.deepEqual(findViewers(rows, 'nobody'), []);
  assert.deepEqual(findViewers(rows, '  zed ').map((r) => r.userId), ['4']);
});
