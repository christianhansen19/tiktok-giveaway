// OBS overlay: live popups over Server-Sent Events, against a real server on a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'overlay-token';
const port = 3800 + Math.floor(Math.random() * 400);
const base = `http://localhost:${port}`;
const admin = (action, body, token = TOKEN) => fetch(`${base}/admin/${action}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

async function boot(dir) {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), ADMIN_TOKEN: TOKEN, DATA_DIR: dir, TIKTOK_USERNAME: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return child; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

// Opens the event stream and collects popup events as they arrive.
async function openStream() {
  const ctl = new AbortController();
  const res = await fetch(`${base}/overlay/stream`, { signal: ctl.signal });
  const popups = [];
  let buf = '';
  const reader = res.body.getReader();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\n').find((l) => l.startsWith('data: '));
          if (data && frame.includes('event: popup')) popups.push(JSON.parse(data.slice(6)));
        }
      }
    } catch {}
  })();
  return {
    res, popups, close: () => ctl.abort(),
    async waitFor(n, ms = 2000) {
      const t0 = Date.now();
      while (popups.length < n && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
      return popups;
    },
  };
}

test('OBS overlay stream', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'));
  const child = await boot(dir);
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

  const s = await openStream();
  t.after(() => s.close());
  assert.equal(s.res.status, 200);
  assert.match(s.res.headers.get('content-type'), /text\/event-stream/);

  await t.test('no popups before the giveaway starts', async () => {
    await admin('adjust', { userId: 'a', nickname: 'Early', coins: 5000 });
    assert.equal((await s.waitFor(1, 400)).length, 0);
  });

  await t.test('qualifying gifts pop up with ornament size and entries; small gifts do not', async () => {
    await admin('start');
    await admin('adjust', { userId: 'b', nickname: 'Matt', coins: 500 });   // too small
    await admin('adjust', { userId: 'b', nickname: 'Matt', coins: 1500 });  // medium, 1 entry
    await admin('adjust', { userId: 'c', nickname: 'Brandt', coins: 15000 }); // large, 15 entries
    const got = await s.waitFor(2);
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((p) => [p.nickname, p.size, p.entriesGained, p.coins]), [['Matt', 'medium', 1, 1500], ['Brandt', 'large', 15, 15000]]);
    assert.equal(got[1].rank, 1);
    assert.equal(got[1].totalEntries, 15);
    assert.equal(got[0].kind, 'manual');
    assert.ok(got.every((p) => p.id && p.ts));
  });

  await t.test('removing a gift never pops up; nothing pops while stopped', async () => {
    await admin('adjust', { userId: 'b', nickname: 'Matt', coins: -1500 });
    await admin('stop');
    await admin('adjust', { userId: 'd', nickname: 'Late', coins: 3000 });
    assert.equal((await s.waitFor(3, 400)).length, 2);
  });

  await t.test('recent endpoint lets a reconnecting overlay catch up', async () => {
    const all = await (await fetch(`${base}/overlay/recent?since=0`)).json();
    assert.equal(all.popups.length, 2);
    const after = await (await fetch(`${base}/overlay/recent?since=${all.popups[0].ts}`)).json();
    assert.ok(after.popups.every((p) => p.ts > all.popups[0].ts));
  });

  await t.test('test popup needs the password and is marked as a test', async () => {
    assert.equal((await admin('test-popup', {}, 'wrong')).status, 401);
    const r = await (await admin('test-popup', { size: 'large' })).json();
    assert.equal(r.overlays, 1, 'one overlay connected');
    const got = await s.waitFor(3);
    assert.equal(got[2].kind, 'test');
    assert.equal(got[2].size, 'large');
    const board = await (await fetch(`${base}/leaderboard`)).json();
    assert.ok(!board.board.some((x) => x.nickname === 'Test Viewer'), 'test popups never touch the giveaway');
  });
});
