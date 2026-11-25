import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TikTokLiveConnection, WebcastEvent, ControlEvent } from 'tiktok-live-connector';
import { aggregate, draw, giftToEvent } from './logic.js';

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

function snapshot() {
  const board = aggregate(giveawayEvents(), EXCLUDED);
  const { active, result } = currentState();
  return {
    active,
    updatedAt: Date.now(),
    totalCoins: board.reduce((s, r) => s + r.coins, 0),
    viewers: board.length,
    board: board.slice(0, 100),
    winner: result ? { nickname: result.nickname, coins: result.coins, seed: result.seed, at: result.ts } : null,
  };
}

// ---- TikTok listener ----
if (TIKTOK_USERNAME) {
  const connect = () => {
    const conn = new TikTokLiveConnection(TIKTOK_USERNAME, {});
    conn.on(WebcastEvent.GIFT, (data) => {
      if (!currentState().active) return;
      const e = giftToEvent(data);
      if (!e) return;
      if (e.msgId && seen.has(e.msgId)) return;
      if (e.msgId) seen.add(e.msgId);
      append(e);
      console.log(`+${e.coins} coins from ${e.nickname} (${e.giftName})`);
    });
    conn.on(ControlEvent.DISCONNECTED, () => {
      console.log('Disconnected, retrying in 10s');
      setTimeout(connect, 10_000);
    });
    conn.on(ControlEvent.ERROR, (err) => console.error('TikTok error:', err?.message ?? err));
    conn.connect().then(
      () => console.log(`Connected to @${TIKTOK_USERNAME}'s LIVE`),
      (err) => {
        console.error('Could not connect (is she live?):', err?.message ?? err);
        setTimeout(connect, 15_000);
      },
    );
  };
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
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname.startsWith('/admin/')) {
    if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`) {
      await new Promise((r) => setTimeout(r, 1000)); // slow down password guessing
      return json(res, 401, { error: 'unauthorized' });
    }
    const body = await readBody(req);
    const action = url.pathname.slice('/admin/'.length);
    const ts = Date.now();

    if (action === 'check') return json(res, 200, { ok: true });
    if (action === 'start') { append({ type: 'start', ts }); return json(res, 200, snapshot()); }
    if (action === 'stop') { append({ type: 'stop', ts }); return json(res, 200, snapshot()); }
    if (action === 'adjust') {
      // Manual correction for a missed/duplicated gift. coins may be negative.
      if (!body.userId || !Number.isFinite(body.coins)) return json(res, 400, { error: 'userId and coins required' });
      append({ type: 'adjust', ts, userId: String(body.userId), nickname: body.nickname, coins: body.coins, note: body.note });
      return json(res, 200, snapshot());
    }
    if (action === 'draw') {
      if (currentState().active) return json(res, 409, { error: 'stop the giveaway before drawing' });
      const seed = body.seed ?? randomBytes(16).toString('hex');
      const r = draw(aggregate(giveawayEvents(), EXCLUDED), seed);
      if (!r) return json(res, 400, { error: 'no eligible coins' });
      append({ type: 'draw', ts, userId: r.winner.userId, nickname: r.winner.nickname, coins: r.winner.coins, seed, pick: r.pick, total: r.total });
      return json(res, 200, { winner: r.winner, seed, pick: r.pick, total: r.total });
    }
    return json(res, 404, { error: 'unknown action' });
  }
  json(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`API on :${PORT}`));
