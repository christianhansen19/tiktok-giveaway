import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { aggregate, buildQueue, draw, giftToEvent } from './logic.js';

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
  events = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const seen = new Set(events.map((e) => e.msgId).filter(Boolean));

function currentState() {
  let active = false;
  let result = null;
  for (const e of events) {
    if (e.type === 'start') { active = true; result = null; }
    if (e.type === 'stop') active = false;
    if (e.type === 'draw') result = e;
  }
  return { active, result };
}

function append(e) {
  events.push(e);
  fs.appendFileSync(LOG, JSON.stringify(e) + '\n');
}

// Only count gifts between "start" and "stop", and only events after the latest "start".
function giveawayEvents() {
  const startIdx = events.map((e) => e.type).lastIndexOf('start');
  return startIdx === -1 ? [] : events.slice(startIdx);
}

function queueSnapshot() {
  const items = buildQueue(events);
  return { items, pending: items.filter((i) => !i.done).length, done: items.filter((i) => i.done).length, now: Date.now() };
}

function snapshot() {
  const board = aggregate(giveawayEvents(), EXCLUDED);
  const { active, result } = currentState();
  return {
    active,
    updatedAt: Date.now(),
    totalCoins: board.reduce((s, r) => s + r.coins, 0),
    totalEntries: board.filter((r) => r.eligible).reduce((s, r) => s + r.entries, 0),
    viewers: board.length,
    board: board.slice(0, 100),
    // Everyone owed at least one ornament (full list, for shipping).
    owed: board
      .filter((r) => r.rewards.small + r.rewards.medium + r.rewards.large > 0)
      .map((r) => ({ userId: r.userId, nickname: r.nickname, ...r.rewards })),
    ornamentTotals: board.reduce(
      (t, r) => ({ small: t.small + r.rewards.small, medium: t.medium + r.rewards.medium, large: t.large + r.rewards.large }),
      { small: 0, medium: 0, large: 0 },
    ),
    winner: result ? { nickname: result.nickname, coins: result.coins, entries: result.entries, seed: result.seed, at: result.ts } : null,
  };
}

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
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => (s += c));
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, 'http://x');

  if (req.method === 'GET' && url.pathname === '/leaderboard') return json(res, 200, snapshot());
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, tiktok, now: Date.now() });

  if (req.method === 'POST' && url.pathname.startsWith('/admin/')) {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
      await new Promise((r) => setTimeout(r, 1000)); // slow down password guessing
      return json(res, 401, { error: 'unauthorized' });
    }
    const body = await readBody(req);
    const action = url.pathname.slice('/admin/'.length);
    const ts = Date.now();

    if (action === 'check') return json(res, 200, { ok: true });
    if (action === 'queue') return json(res, 200, queueSnapshot());
    if (action === 'ornament') {
      // Olivia ticks an ornament as written (done: true) or un-ticks it (done: false).
      const item = buildQueue(events).find((i) => i.id === body.itemId);
      if (!item) return json(res, 404, { error: 'that ornament is no longer in the queue' });
      if (item.done !== !!body.done) append({ type: 'ornament_check', ts, itemId: item.id, done: !!body.done });
      return json(res, 200, queueSnapshot());
    }
    if (action === 'start') { append({ type: 'start', ts }); return json(res, 200, snapshot()); }
    if (action === 'stop') { append({ type: 'stop', ts }); return json(res, 200, snapshot()); }
    if (action === 'adjust') {
      // Manual correction: coins = value of ONE gift to add (positive) or to remove (negative).
      if (!body.userId || !Number.isFinite(body.coins)) return json(res, 400, { error: 'userId and coins required' });
      append({ type: 'adjust', ts, userId: String(body.userId), nickname: body.nickname, coins: body.coins, note: body.note });
      return json(res, 200, snapshot());
    }
    if (action === 'draw') {
      if (currentState().active) return json(res, 409, { error: 'stop the giveaway before drawing' });
      const seed = body.seed ?? randomBytes(16).toString('hex');
      const r = draw(aggregate(giveawayEvents(), EXCLUDED), seed);
      if (!r) return json(res, 400, { error: 'nobody has any entries yet (a gift must be 1,000+ coins to earn an ornament)' });
      append({ type: 'draw', ts, userId: r.winner.userId, nickname: r.winner.nickname, coins: r.winner.coins, entries: r.winner.entries, seed, pick: r.pick, total: r.total });
      return json(res, 200, { winner: r.winner, seed, pick: r.pick, total: r.total });
    }
    return json(res, 404, { error: 'unknown action' });
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`API on :${PORT}`));
