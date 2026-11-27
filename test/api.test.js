// End-to-end tests: boots the real server (no TikTok connection) against a temp data folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TOKEN = 'test-token';
let port = 3200 + Math.floor(Math.random() * 500);
const base = () => `http://localhost:${port}`;

function boot(dir) {
  port += 1;
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), ADMIN_TOKEN: TOKEN, DATA_DIR: dir, TIKTOK_USERNAME: '', ALLOW_ORIGIN: 'https://example.github.io' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      try { if ((await fetch(`${base()}/health`)).ok) return resolve({ child, getLog: () => log }); } catch {}
      if (Date.now() - t0 > 8000) return reject(new Error('server did not start: ' + log));
      setTimeout(tick, 100);
    };
    tick();
  });
}
const stop = (srv) => new Promise((r) => { srv.child.once('exit', r); srv.child.kill(); });
const admin = (action, body, token = TOKEN) => fetch(`${base()}/admin/${action}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
const jsonOf = async (r) => r.json();
const board = async () => jsonOf(await fetch(`${base()}/leaderboard`));

test('API end to end', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'giveaway-'));
  let srv = await boot(dir);
  t.after(() => { srv.child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  await t.test('public endpoints work with no giveaway yet; CORS is limited to the Pages origin', async () => {
    const r = await fetch(`${base()}/leaderboard`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('access-control-allow-origin'), 'https://example.github.io');
    const d = await r.json();
    assert.equal(d.active, false);
    assert.equal(d.viewers, 0);
    assert.deepEqual(d.board, []);
    assert.equal('owed' in d, false, 'no leftover shipping list on the public feed');
    const pre = await fetch(`${base()}/admin/queue`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal((await fetch(`${base()}/nope`)).status, 404);
  });

  await t.test('admin endpoints reject a missing or wrong password', async () => {
    for (const action of ['check', 'queue', 'viewers', 'ornament', 'start', 'stop', 'adjust', 'draw']) {
      assert.equal((await admin(action, {}, 'wrong')).status, 401, action);
    }
    assert.equal((await fetch(`${base()}/admin/start`, { method: 'POST' })).status, 401);
    assert.equal((await admin('check')).status, 200);
    assert.equal((await admin('does-not-exist')).status, 404);
  });

  await t.test('gifts are ignored until a giveaway is started; start refuses while running', async () => {
    assert.equal((await admin('draw')).status, 400, 'nothing to draw before a giveaway starts');
    const r1 = await admin('start');
    assert.equal(r1.status, 200);
    assert.equal((await jsonOf(r1)).active, true);
    const again = await admin('start');
    assert.equal(again.status, 409, 'second start must not wipe the board');
  });

  await t.test('adjust validates input and applies the per-gift rules', async () => {
    assert.equal((await admin('adjust', { coins: 1500 })).status, 400); // no user
    assert.equal((await admin('adjust', { userId: 'x', coins: 'abc' })).status, 400);
    assert.equal((await admin('adjust', { userId: 'x', coins: 0 })).status, 400);
    assert.equal((await admin('adjust', { userId: 'x', coins: 99999999999 })).status, 400);
    for (const [userId, nickname, coins] of [['a', 'Brandt', 12000], ['b', 'Matt', 1500], ['b', 'Matt', 1500], ['c', 'Paul', 600], ['c', 'Paul', 600], ['d', '<img src=x onerror=alert(1)>', 5200]]) {
      assert.equal((await admin('adjust', { userId, nickname, coins })).status, 200);
    }
    const d = await board();
    assert.equal(d.viewers, 4);
    assert.equal(d.entrants, 3, 'Paul only sent small gifts, so no entries');
    const byName = Object.fromEntries(d.board.map((r) => [r.nickname, r]));
    assert.deepEqual(byName.Brandt.rewards, { medium: 0, large: 1 });
    assert.equal(byName.Brandt.entries, 12);
    assert.deepEqual(byName.Matt.rewards, { medium: 2, large: 0 });
    assert.equal(byName.Matt.entries, 2);
    assert.deepEqual(d.board.map((r) => r.rank), [1, 2, 3]);
    assert.equal(d.others.count, 1);
    assert.deepEqual(d.others.top, [{ nickname: 'Paul', coins: 1200 }]);
    assert.equal(d.totalEntries, 12 + 2 + 5);
    assert.deepEqual(d.ornamentTotals, { medium: 3, large: 1 });
  });

  await t.test('lookup finds anyone, including people with no entries; rejects short input', async () => {
    const hit = await jsonOf(await fetch(`${base()}/lookup?q=pau`));
    assert.equal(hit.matches.length, 1);
    assert.equal(hit.matches[0].nickname, 'Paul');
    assert.equal(hit.matches[0].rank, null);
    assert.equal(hit.matches[0].entries, 0);
    const ranked = await jsonOf(await fetch(`${base()}/lookup?q=MATT`));
    assert.equal(ranked.matches[0].rank > 0, true);
    assert.equal((await fetch(`${base()}/lookup?q=a`)).status, 400);
    assert.equal((await fetch(`${base()}/lookup`)).status, 400);
    assert.deepEqual((await jsonOf(await fetch(`${base()}/lookup?q=zzzz`))).matches, []);
  });

  await t.test('viewers list (admin) includes everyone, sorted by name', async () => {
    const { viewers } = await jsonOf(await admin('viewers'));
    assert.deepEqual(viewers.map((v) => v.userId), ['d', 'a', 'b', 'c'].sort((x, y) => {
      const n = { a: 'Brandt', b: 'Matt', c: 'Paul', d: '<img src=x onerror=alert(1)>' };
      return n[x].localeCompare(n[y], undefined, { sensitivity: 'base' });
    }));
  });

  await t.test('ornament queue: one row per qualifying gift, check/uncheck, bad id', async () => {
    let q = await jsonOf(await admin('queue'));
    assert.equal(q.items.length, 4); // 12000, 1500, 1500, 5200 (the two 600s add nothing)
    assert.deepEqual(q.items.map((i) => i.size), ['large', 'medium', 'medium', 'medium']);
    assert.equal(q.pending, 4);
    const id = q.items[0].id;
    q = await jsonOf(await admin('ornament', { itemId: id, done: true }));
    assert.deepEqual([q.pending, q.done], [3, 1]);
    q = await jsonOf(await admin('ornament', { itemId: id, done: true })); // idempotent
    assert.deepEqual([q.pending, q.done], [3, 1]);
    assert.equal((await admin('ornament', { itemId: '9999', done: true })).status, 404);
    assert.equal((await admin('ornament', {})).status, 404);
    q = await jsonOf(await admin('ornament', { itemId: id, done: false }));
    assert.deepEqual([q.pending, q.done], [4, 0]);
    await admin('ornament', { itemId: id, done: true });
  });

  await t.test('draw: refused while running; works once stopped; cannot be redone', async () => {
    const running = await admin('draw');
    assert.equal(running.status, 409);
    const stopped = await jsonOf(await admin('stop'));
    assert.equal(stopped.active, false);
    await admin('stop'); // idempotent
    const first = await admin('draw', { seed: 'fixed-seed' });
    assert.equal(first.status, 200);
    const w = await jsonOf(first);
    assert.ok(['Brandt', 'Matt', '<img src=x onerror=alert(1)>'].includes(w.winner.nickname));
    assert.equal(w.total, 19);
    // The reveal data: pool in draw order, pick reproducible from the seed alone.
    assert.equal(w.pool.reduce((a, p) => a + p.entries, 0), w.total);
    const pick = (createHash('sha256').update('fixed-seed:0').digest().readUIntBE(0, 6) / 2 ** 48) * w.total;
    assert.ok(Math.abs(pick - w.pick) < 1e-9, 'pick must be derivable from the seed');
    let acc = 0, expected = null;
    for (const p of w.pool) { acc += p.entries; if (pick < acc) { expected = p; break; } }
    assert.equal(expected.userId, w.winner.userId, 'walking the pool with the pick lands on the winner');
    const info = await jsonOf(await admin('drawinfo'));
    assert.equal(info.winner.userId, w.winner.userId);
    assert.equal(info.seed, 'fixed-seed');
    assert.equal(info.total, w.total);
    assert.deepEqual(info.pool.map((p) => [p.userId, p.entries]), w.pool.map((p) => [p.userId, p.entries]));
    const second = await admin('draw');
    assert.equal(second.status, 409, 'winner cannot be silently replaced');
    const d = await board();
    assert.equal(d.winner.nickname, w.winner.nickname);
    assert.equal(d.winner.seed, 'fixed-seed');
  });

  await t.test('respin: needs force, skips previous winners by default, replay shows the respin', async () => {
    const first = await board();
    const re = await admin('draw', { force: true, seed: 'respin-1' });
    assert.equal(re.status, 200);
    const r = await jsonOf(re);
    assert.equal(r.respin, true);
    assert.equal(r.skipped, 1);
    assert.notEqual(r.winner.nickname, first.winner.nickname, 'previous winner is skipped');
    assert.ok(!r.pool.some((p) => p.nickname === first.winner.nickname));
    assert.equal(r.pool.reduce((a, p) => a + p.entries, 0), r.total);
    const pick = (createHash('sha256').update('respin-1:0').digest().readUIntBE(0, 6) / 2 ** 48) * r.total;
    assert.ok(Math.abs(pick - r.pick) < 1e-9);
    const info = await jsonOf(await admin('drawinfo'));
    assert.equal(info.winner.userId, r.winner.userId);
    assert.deepEqual(info.pool.map((p) => p.userId), r.pool.map((p) => p.userId), 'replay uses the same reduced pool');
    const d = await board();
    assert.equal(d.winner.nickname, r.winner.nickname, 'newest draw is the official winner');
    assert.equal(d.draws, 2);
    // a respin that allows previous winners uses the full pool again
    const all = await jsonOf(await admin('draw', { force: true, skipPrevious: false, seed: 'respin-2' }));
    assert.equal(all.skipped, 0);
    assert.equal(all.total, 19);
  });

  await t.test('survives a restart, and a corrupt log line does not stop it booting', async () => {
    const before = await board();
    const qBefore = await jsonOf(await admin('queue'));
    await stop(srv);
    fs.appendFileSync(path.join(dir, 'events.jsonl'), '{"type":"gift","userId":"zz","coi'); // partial line from a crash
    srv = await boot(dir);
    assert.match(srv.getLog(), /Skipping unreadable log line/);
    const after = await board();
    assert.equal(after.totalCoins, before.totalCoins);
    assert.equal(after.totalEntries, before.totalEntries);
    assert.equal(after.winner.nickname, before.winner.nickname);
    const qAfter = await jsonOf(await admin('queue'));
    assert.deepEqual([qAfter.pending, qAfter.done], [qBefore.pending, qBefore.done]);
  });

  await t.test('resume turns counting back on without wiping anything', async () => {
    const before = await board();
    assert.equal(before.active, false);
    assert.equal(before.started, true);
    const r = await jsonOf(await admin('resume'));
    assert.equal(r.active, true);
    assert.equal(r.totalCoins, before.totalCoins);
    assert.equal(r.totalEntries, before.totalEntries);
    assert.equal((await jsonOf(await admin('resume'))).active, true); // idempotent
    await admin('adjust', { userId: 'b', nickname: 'Matt', coins: 1000 });
    assert.equal((await board()).totalEntries, before.totalEntries + 1, 'gifts count again after resume');
    await admin('stop');
  });

  await t.test('a new giveaway after a finished one starts clean and clears the winner', async () => {
    const r = await admin('start');
    assert.equal(r.status, 200);
    const d = await board();
    assert.equal(d.viewers, 0);
    assert.equal(d.winner, null);
    assert.equal((await jsonOf(await admin('queue'))).items.length, 0);
  });

  await t.test('drawinfo is 404 before any winner; queue payload is capped to pending + latest 100 written', async () => {
    assert.equal((await admin('drawinfo')).status, 404);
    for (let i = 0; i < 130; i++) await admin('adjust', { userId: `u${i}`, nickname: `U${i}`, coins: 1000 });
    let q = await jsonOf(await admin('queue'));
    assert.equal(q.pending, 130);
    for (const it of q.items.slice(0, 120)) await admin('ornament', { itemId: it.id, done: true });
    q = await jsonOf(await admin('queue'));
    assert.deepEqual([q.pending, q.done], [10, 120]);
    assert.equal(q.items.length, 10 + 100, 'all pending plus only the latest 100 written');
  });

  await t.test('bad input never crashes the server', async () => {
    const bad = await fetch(`${base()}/admin/adjust`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{not json' });
    assert.equal(bad.status, 400);
    const huge = await fetch(`${base()}/admin/adjust`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: 'x'.repeat(100000) }).catch(() => null);
    assert.ok(huge === null || huge.status === 400);
    assert.equal((await fetch(`${base()}/health`)).status, 200);
  });
});
