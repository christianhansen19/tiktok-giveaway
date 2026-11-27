import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { aggregate, buildQueue, draw, findViewers, giftEntries, giftToEvent, rewards } from './logic.js';

const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME; // streamer's @handle, no "@"
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // required for admin endpoints
const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? './data';
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN ?? '*'; // set to your GitHub Pages origin
const EXCLUDED = new Set((process.env.EXCLUDED_USER_IDS ?? '').split(',').filter(Boolean));

if (!ADMIN_TOKEN) {
  console.error('Set ADMIN_TOKEN so only you can start/stop/draw.');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
const LOG = path.join(DATA_DIR, 'events.jsonl'); // append-only source of truth

// ---- state: rebuilt from the log on boot, so restarts lose nothing ----
let events = [];
if (fs.existsSync(LOG)) {
  // A crash mid-write can leave one partial line: skip it instead of refusing to boot.
  for (const [n, line] of fs.readFileSync(LOG, 'utf8').split('\n').entries()) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { console.error(`Skipping unreadable log line ${n + 1}`); }
  }
}
const seen = new Set(events.map((e) => e.msgId).filter(Boolean));

function append(e) {
  events.push(e);
  fs.appendFileSync(LOG, JSON.stringify(e) + '\n');
}

// Everything derived from the log, recomputed only when the log has grown (the board is
// asked for by every visitor every few seconds, so this keeps it cheap with thousands of gifts).
let cache = { len: -1 };
function derived() {
  if (cache.len === events.length) return cache;
  let startIdx = -1, drawIdx = -1, active = false, result = null, winners = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'start') { startIdx = i; drawIdx = -1; active = true; result = null; winners = []; }
    else if (e.type === 'stop') active = false;
    else if (e.type === 'resume' && startIdx !== -1) active = true; // keep counting, no reset
    else if (e.type === 'draw') { result = e; drawIdx = i; winners.push(e.userId); }
  }
  const rows = aggregate(startIdx === -1 ? [] : events.slice(startIdx), EXCLUDED);
  cache = { len: events.length, startIdx, drawIdx, active, result, rows, winners };
  return cache;
}
const currentState = () => derived();

const QUEUE_DONE_SHOWN = 100;
function queueSnapshot() {
  // Every unwritten ornament, plus the latest few written ones (keeps the payload small on a long giveaway).
  const items = buildQueue(events);
  const pending = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);
  return { items: [...pending, ...done.slice(-QUEUE_DONE_SHOWN)], pending: pending.length, done: done.length, now: Date.now() };
}

// Everyone in the draw pool, in the exact order the draw walks them (for the on-screen reveal).
const poolOf = (rows) => rows.filter((r) => r.eligible && r.entries > 0).map((r) => ({ userId: r.userId, nickname: r.nickname ?? r.userId, entries: r.entries }));

function snapshot() {
  const { active, result, rows } = derived();
  const entrants = rows.filter((r) => r.entries > 0);
  const others = rows.filter((r) => r.entries === 0); // sent coins but no qualifying gift yet
  return {
    active,
    started: derived().startIdx !== -1,
    draws: derived().winners.length,
    updatedAt: Date.now(),
    totalCoins: rows.reduce((s, r) => s + r.coins, 0),
    totalEntries: rows.filter((r) => r.eligible).reduce((s, r) => s + r.entries, 0),
    viewers: rows.length,
    entrants: entrants.length,
    board: entrants.slice(0, 300).map(publicRow),
    others: { count: others.length, top: others.slice(0, 15).map((r) => ({ nickname: r.nickname, coins: r.coins })) },
    ornamentTotals: rows.reduce(
      (t, r) => ({ medium: t.medium + r.rewards.medium, large: t.large + r.rewards.large }),
      { medium: 0, large: 0 },
    ),
    winner: result ? { nickname: result.nickname, coins: result.coins, entries: result.entries, seed: result.seed, at: result.ts } : null,
  };
}
const publicRow = (r) => ({ rank: r.rank, userId: r.userId, nickname: r.nickname, coins: r.coins, rewards: r.rewards, entries: r.entries, eligible: r.eligible, odds: r.odds });

// ---- OBS overlay: live popups over Server-Sent Events ----
// Every qualifying gift (single gift of 1,000+ coins, while the giveaway runs) is pushed to
// connected overlays. The last 2 minutes are kept so a reconnecting overlay can catch up.
const overlayClients = new Set();
const recentPopups = [];
const RECENT_MS = 2 * 60 * 1000;
let popupSeq = 0;
function broadcast(popup) {
  popup.id = `${popup.ts}-${++popupSeq}`;
  recentPopups.push(popup);
  while (recentPopups.length && recentPopups[0].ts < Date.now() - RECENT_MS) recentPopups.shift();
  const frame = `id: ${popup.id}\nevent: popup\ndata: ${JSON.stringify(popup)}\n\n`;
  for (const res of overlayClients) { try { res.write(frame); } catch { overlayClients.delete(res); } }
}
function popupFor(e, kind) {
  const coins = Math.abs(e.coins);
  if (e.coins <= 0 || coins < 1000) return null; // only qualifying gifts get a popup
  const r = rewards(coins);
  const row = derived().rows.find((x) => x.userId === e.userId);
  return {
    kind, ts: Date.now(), nickname: e.nickname ?? e.userId, coins, giftName: e.giftName ?? null,
    size: r.large ? 'large' : 'medium', entriesGained: giftEntries(coins),
    totalEntries: row?.entries ?? giftEntries(coins), rank: row?.rank ?? null,
  };
}
function notifyOverlay(e, kind) {
  if (!derived().active) return;
  const p = popupFor(e, kind);
  if (p) broadcast(p);
}
// Keep idle connections alive through Railway's proxy.
setInterval(() => { for (const res of overlayClients) { try { res.write(': ping\n\n'); } catch { overlayClients.delete(res); } } }, 20_000);

// ---- TikTok listener ----
// Shared status, shown on the admin page via /health.
const tiktok = { username: TIKTOK_USERNAME ?? null, connected: false, connectedSince: 0, lastEventAt: 0 };

if (TIKTOK_USERNAME) {
  // Reconnect rules (polite to TikTok, but never stuck on an old stream):
  // - she's offline: check about every OFFLINE_CHECK_SEC (default 90s) +/- 25% jitter
  // - the connection drops mid-stream: one quick retry after 10s, then the slow check
  // - the stream ends: drop it and go back to the slow check, which finds her NEXT stream
  // - the connection goes quiet (no events for STALE_SEC, default 180s) while "connected":
  //   treat it as dead (e.g. stuck on a stream that already ended) and reconnect
  const OFFLINE_CHECK_MS = Number(process.env.OFFLINE_CHECK_SEC ?? 90) * 1000;
  const STALE_MS = Number(process.env.STALE_SEC ?? 180) * 1000;
  const CONNECT_TIMEOUT_MS = 45_000;
  let retryTimer = null;
  let current = null;

  const slowDelay = () => OFFLINE_CHECK_MS * (0.75 + Math.random() * 0.5);
  const scheduleRetry = (ms) => {
    if (retryTimer) return; // never stack timers
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, ms);
  };
  function dropConnection(reason, retryMs) {
    const old = current;
    current = null;
    tiktok.connected = false;
    if (old) { try { Promise.resolve(old.disconnect()).catch(() => {}); } catch {} }
    const ms = retryMs ?? slowDelay();
    console.log(`${reason}; checking again in ${Math.round(ms / 1000)}s`);
    scheduleRetry(ms);
  }

  const connect = () => {
    const conn = new TikTokLiveConnection(TIKTOK_USERNAME, {});
    current = conn;
    const alive = () => { tiktok.lastEventAt = Date.now(); };
    // Any of these counts as proof the connection is alive (viewer-count updates arrive every few seconds).
    for (const ev of [WebcastEvent.ROOM_USER, WebcastEvent.CHAT, WebcastEvent.MEMBER, WebcastEvent.LIKE, WebcastEvent.SOCIAL]) {
      conn.on(ev, () => { if (conn === current) alive(); });
    }
    conn.on(WebcastEvent.GIFT, (data) => {
      if (conn !== current) return;
      alive();
      const e = giftToEvent(data);
      // Log every gift message (counted or not) so problems are visible in Railway logs.
      try {
        console.log('GIFT', JSON.stringify({
          counted: !!e && currentState().active,
          active: currentState().active,
          user: data?.user?.nickname ?? data?.nickname,
          userId: data?.user?.userId ?? data?.user?.idStr ?? data?.userId,
          giftId: data?.giftId,
          giftName: data?.gift?.name ?? data?.giftDetails?.giftName ?? data?.giftName,
          giftType: data?.gift?.type ?? data?.giftDetails?.giftType ?? data?.giftType,
          diamondCount: data?.gift?.diamondCount ?? data?.giftDetails?.diamondCount ?? data?.diamondCount,
          repeatCount: data?.repeatCount,
          repeatEnd: data?.repeatEnd,
        }));
      } catch {}
      if (!currentState().active) return;
      if (!e) return;
      if (e.msgId && seen.has(e.msgId)) return;
      if (e.msgId) seen.add(e.msgId);
      append(e);
      notifyOverlay(e, 'gift');
      console.log(`+${e.coins} coins from ${e.nickname} (${e.giftName})`);
    });
    conn.on(WebcastEvent.STREAM_END, () => { if (conn === current) dropConnection('Stream ended'); });
    conn.on(ControlEvent.DISCONNECTED, () => {
      if (conn !== current) return;
      dropConnection('Disconnected mid-stream', tiktok.connected ? 10_000 : undefined);
    });
    conn.on(ControlEvent.ERROR, (err) => console.error('TikTok error:', String(err?.message ?? err).slice(0, 160)));

    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('connect timed out')), CONNECT_TIMEOUT_MS));
    Promise.race([conn.connect(), timeout]).then(
      () => {
        if (conn !== current) return;
        tiktok.connected = true; tiktok.connectedSince = Date.now(); alive();
        console.log(`Connected to @${TIKTOK_USERNAME}'s LIVE`);
      },
      (err) => { if (conn === current) dropConnection(`Not connected (offline?): ${err?.message ?? err}`); },
    );
  };

  // Watchdog: a connection that has gone silent is treated as dead and replaced.
  setInterval(() => {
    if (tiktok.connected && Date.now() - tiktok.lastEventAt > STALE_MS) {
      dropConnection(`No activity for ${Math.round(STALE_MS / 1000)}s, reconnecting`, 5_000);
    }
  }, 30_000);

  connect();
} else {
  console.warn('TIKTOK_USERNAME not set: running API only.');
}

// ---- HTTP API ----
const json = (res, code, body) => {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(code === 204 ? undefined : JSON.stringify(body));
};
const MAX_BODY = 20_000;
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > MAX_BODY) { req.destroy(); resolve({}); } });
  req.on('end', () => { try { const b = JSON.parse(s || '{}'); resolve(b && typeof b === 'object' ? b : {}); } catch { resolve({}); } });
});
const cleanText = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

async function handle(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204);
  const url = new URL(req.url, 'http://x');

  // ---- public ----
  if (req.method === 'GET' && url.pathname === '/overlay/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    });
    res.write('retry: 3000\n: connected\n\n');
    overlayClients.add(res);
    req.on('close', () => overlayClients.delete(res));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/overlay/recent') {
    const since = Number(url.searchParams.get('since') ?? 0);
    const cutoff = Date.now() - RECENT_MS;
    return json(res, 200, { popups: recentPopups.filter((p) => p.ts > since && p.ts >= cutoff), now: Date.now() });
  }
  if (req.method === 'GET' && url.pathname === '/leaderboard') return json(res, 200, snapshot());
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, tiktok, now: Date.now() });
  if (req.method === 'GET' && url.pathname === '/lookup') {
    // "Find yourself": searches EVERYONE (not just the ranked board), at most 5 matches.
    const q = (url.searchParams.get('q') ?? '').slice(0, 40);
    if (q.trim().length < 2) return json(res, 400, { error: 'type at least 2 letters' });
    return json(res, 200, { matches: findViewers(derived().rows, q, 5).map(publicRow), now: Date.now() });
  }

  // ---- admin (password required) ----
  if (req.method === 'POST' && url.pathname.startsWith('/admin/')) {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
      await new Promise((r) => setTimeout(r, 1000)); // slow down password guessing
      return json(res, 401, { error: 'unauthorized' });
    }
    const body = await readBody(req);
    const action = url.pathname.slice('/admin/'.length);
    const ts = Date.now();
    const st = derived();

    if (action === 'check') return json(res, 200, { ok: true });
    if (action === 'test-popup') {
      // A clearly fake popup so Olivia can position the overlay in OBS. Never touches the log.
      const large = body.size === 'large';
      const coins = large ? 15000 : 1500;
      broadcast({ kind: 'test', ts: Date.now(), nickname: 'Test Viewer', coins, giftName: large ? 'Test Lion' : 'Test Galaxy', size: large ? 'large' : 'medium', entriesGained: giftEntries(coins), totalEntries: giftEntries(coins), rank: 1 });
      return json(res, 200, { ok: true, overlays: overlayClients.size });
    }
    if (action === 'queue') return json(res, 200, queueSnapshot());
    if (action === 'viewers') {
      // Everyone who has sent a gift, for the "add or remove a gift" picker.
      const list = st.rows.map((r) => ({ userId: r.userId, nickname: r.nickname ?? r.userId, coins: r.coins, entries: r.entries }));
      list.sort((a, b) => String(a.nickname).localeCompare(String(b.nickname), undefined, { sensitivity: 'base' }));
      return json(res, 200, { viewers: list });
    }
    if (action === 'ornament') {
      // Olivia ticks an ornament as written (done: true) or un-ticks it (done: false).
      const item = buildQueue(events).find((i) => i.id === String(body.itemId));
      if (!item) return json(res, 404, { error: 'that ornament is no longer in the queue' });
      if (item.done !== !!body.done) append({ type: 'ornament_check', ts, itemId: item.id, done: !!body.done });
      return json(res, 200, queueSnapshot());
    }
    if (action === 'start') {
      // Starting wipes the board, so refuse while one is running (guards double-taps and two admins).
      if (st.active) return json(res, 409, { error: 'A giveaway is already running. Stop it first if you really want a new one.' });
      append({ type: 'start', ts });
      return json(res, 200, snapshot());
    }
    if (action === 'resume') {
      // Turn counting back on after a Stop WITHOUT wiping anything.
      if (st.startIdx === -1) return json(res, 409, { error: 'There is no giveaway to resume. Press Start to begin one.' });
      if (!st.active) append({ type: 'resume', ts });
      return json(res, 200, snapshot());
    }
    if (action === 'stop') {
      if (st.active) append({ type: 'stop', ts });
      return json(res, 200, snapshot());
    }
    if (action === 'adjust') {
      // Manual correction: coins = value of ONE gift to add (positive) or to remove (negative).
      const coins = Number(body.coins);
      const userId = cleanText(String(body.userId ?? ''), 64);
      if (!userId || !Number.isFinite(coins) || coins === 0 || Math.abs(coins) > 10_000_000) {
        return json(res, 400, { error: 'userId and a gift value between 1 and 10,000,000 coins are required' });
      }
      const adj = { type: 'adjust', ts, userId, nickname: cleanText(body.nickname, 80) ?? userId, coins: Math.trunc(coins), note: cleanText(body.note, 200) };
      append(adj);
      notifyOverlay(adj, 'manual'); // a gift added by hand still gets its on-stream thank-you
      return json(res, 200, snapshot());
    }
    if (action === 'drawinfo') {
      // Everything needed to replay the on-screen reveal of the latest draw.
      if (!st.result) return json(res, 404, { error: 'No winner has been drawn yet.' });
      const w = st.result;
      const skip = new Set(w.skip ?? []);
      const rowsThen = aggregate(events.slice(st.startIdx, st.drawIdx), EXCLUDED).filter((r) => !skip.has(r.userId));
      return json(res, 200, { winner: { userId: w.userId, nickname: w.nickname, coins: w.coins, entries: w.entries }, seed: w.seed, pick: w.pick, total: w.total, pool: poolOf(rowsThen), skipped: skip.size, respin: (st.winners.length > 1), at: w.ts });
    }
    if (action === 'draw') {
      if (st.active) return json(res, 409, { error: 'Stop the giveaway before drawing.' });
      // A second draw is a respin: only with force. By default a respin skips anyone who already won.
      if (st.result && body.force !== true) return json(res, 409, { error: `A winner was already drawn: ${st.result.nickname}.`, winner: { nickname: st.result.nickname } });
      const skipIds = st.result && body.skipPrevious !== false ? [...new Set(st.winners)] : [];
      const skip = new Set(skipIds);
      const rows = st.rows.filter((r) => !skip.has(r.userId));
      const seed = cleanText(body.seed, 100) ?? randomBytes(16).toString('hex');
      const r = draw(rows, seed);
      if (!r) return json(res, 400, { error: skipIds.length ? 'Nobody else has entries to respin to.' : 'Nobody has any entries yet (a single gift must be 1,000+ coins to earn an ornament and entries).' });
      append({ type: 'draw', ts, userId: r.winner.userId, nickname: r.winner.nickname, coins: r.winner.coins, entries: r.winner.entries, seed, pick: r.pick, total: r.total, skip: skipIds, respin: !!st.result });
      return json(res, 200, { winner: publicRow(r.winner), seed, pick: r.pick, total: r.total, pool: poolOf(rows), skipped: skipIds.length, respin: !!st.result });
    }
    return json(res, 404, { error: 'unknown action' });
  }
  json(res, 404, { error: 'not found' });
}

http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('Request failed:', req.method, req.url, String(err?.message ?? err).slice(0, 200));
    if (!res.headersSent) json(res, 500, { error: 'server error' }); else res.end();
  });
}).listen(PORT, () => console.log(`API on :${PORT}`));

// Never let one bad event take the whole server (and the giveaway) down.
process.on('uncaughtException', (err) => console.error('Uncaught:', String(err?.stack ?? err).slice(0, 400)));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', String(err?.message ?? err).slice(0, 200)));
