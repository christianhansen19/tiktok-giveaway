import { createHash } from 'node:crypto';

// RULES
// Only a SINGLE gift of 1,000+ coins counts (a streak counts as one gift at its total).
// Small gifts never add up: two 500-coin gifts earn nothing.
// 1. One ornament per qualifying gift (one name written per gift):
//      1,000 - 9,999 coins -> 1 medium ornament
//      10,000+ coins       -> 1 large ornament
// 2. Entries for the draw come only from qualifying gifts: 1 per 1,000 coins, rounded down
//    per gift. 15,000 = 1 large ornament and 15 entries. 1,500 = 1 medium, 1 entry.
//    A viewer's chance to win = their entries / all eligible entries.
export const MIN_GIFT = 1000;
export const LARGE_MIN = 10000;
export const TIERS = [
  { key: 'medium', min: MIN_GIFT },
  { key: 'large', min: LARGE_MIN },
];

// Ornament earned by ONE gift worth `coins` (at most one).
export function rewards(coins) {
  return {
    medium: coins >= MIN_GIFT && coins < LARGE_MIN ? 1 : 0,
    large: coins >= LARGE_MIN ? 1 : 0,
  };
}

// Draw entries earned by ONE gift worth `coins`.
export function giftEntries(coins) {
  return coins >= MIN_GIFT ? Math.floor(coins / 1000) : 0;
}

// Convert a raw TikTok gift message into a log event, or null if it should not count yet.
// Streakable gifts (giftType 1) fire repeatedly while a streak runs; only the final
// message (repeatEnd = true) carries the full repeatCount, so we count only that one.
// Coins = diamondCount (the gift's coin price) x repeatCount.
export function giftToEvent(data, now = Date.now()) {
  const g = data?.gift ?? data?.giftDetails ?? {};
  const giftType = g.type ?? g.giftType ?? data?.giftType;
  const repeatEnd = !!data?.repeatEnd;
  if (giftType === 1 && !repeatEnd) return null; // streak still running
  const unit = Number(g.diamondCount ?? data?.diamondCount ?? 0);
  const repeat = Math.max(Number(data?.repeatCount ?? 1), 1);
  const coins = unit * repeat;
  const user = data?.user ?? data ?? {};
  const userId = String(user.userId ?? user.idStr ?? user.uniqueId ?? '');
  if (!userId || !(coins > 0)) return null;
  return {
    type: 'gift',
    ts: now,
    userId,
    uniqueId: user.uniqueId,
    nickname: user.nickname ?? user.uniqueId,
    giftId: data?.giftId,
    giftName: g.name ?? g.giftName ?? data?.giftName,
    coins,
    msgId: data?.common?.msgId != null ? String(data.common.msgId) : undefined,
  };
}

// Rebuild per-viewer results from the event log (the log is the source of truth).
// events: gift {coins} = one gift; adjust {coins} = add one gift of that value (positive)
// or remove a mistakenly counted gift of that value (negative).
export function aggregate(events, excluded = new Set()) {
  const byUser = new Map();
  for (const e of events) {
    if (e.type !== 'gift' && e.type !== 'adjust') continue;
    const u = byUser.get(e.userId) ?? {
      userId: e.userId, nickname: e.nickname, coins: 0, entries: 0, orn: { medium: 0, large: 0 },
    };
    const sign = e.coins < 0 ? -1 : 1;
    const value = Math.abs(e.coins);
    const r = rewards(value);
    for (const t of TIERS) u.orn[t.key] += sign * r[t.key];
    u.entries += sign * giftEntries(value);
    u.coins += e.coins;
    if (e.nickname) u.nickname = e.nickname; // latest nickname wins
    byUser.set(e.userId, u);
  }

  const viewers = [...byUser.values()].filter((u) => u.coins > 0).map((u) => ({
    ...u,
    rewards: { medium: Math.max(u.orn.medium, 0), large: Math.max(u.orn.large, 0) },
    entries: Math.max(u.entries, 0),
    eligible: !excluded.has(u.userId),
  }));
  // Excluded users (streamer, mods, bots) still appear on the board but are not in the draw pool.
  const poolEntries = viewers.filter((v) => v.eligible).reduce((s, v) => s + v.entries, 0);

  return viewers
    .sort((a, b) => b.entries - a.entries || b.coins - a.coins)
    .map((v, i) => ({
      rank: i + 1,
      userId: v.userId,
      nickname: v.nickname,
      coins: v.coins,
      rewards: v.rewards,
      entries: v.entries,
      eligible: v.eligible,
      odds: v.eligible && poolEntries > 0 ? v.entries / poolEntries : 0,
    }));
}

// Deterministic PRNG from a string seed, so the draw can be re-verified on stream.
export function seededRandom(seed) {
  let counter = 0;
  return () => {
    const h = createHash('sha256').update(`${seed}:${counter++}`).digest();
    return h.readUIntBE(0, 6) / 2 ** 48; // [0,1)
  };
}

// Weighted draw: probability = entries / total entries of eligible viewers.
export function draw(board, seed) {
  const pool = board.filter((r) => r.eligible && r.entries > 0);
  const total = pool.reduce((s, r) => s + r.entries, 0);
  if (total <= 0) return null;
  const pick = seededRandom(seed)() * total;
  let acc = 0;
  for (const r of pool) {
    acc += r.entries;
    if (pick < acc) return { winner: r, seed, pick, total };
  }
  return { winner: pool[pool.length - 1], seed, pick, total };
}

// ORNAMENT QUEUE: one item per qualifying gift (= one ornament), oldest first, for the
// current giveaway. Items are derived from the event log, so nothing is stored twice:
//  - each gift / positive manual adjust of 1,000+ coins adds one item (medium or large)
//  - a negative manual adjust cancels the latest still-unwritten item of that size for that viewer
//  - `ornament_check` events mark an item written / un-written (last event wins)
// Item id = "<position in the full log>". The log is append-only, so ids never change.
// Legacy: before the one-ornament-per-gift rule, check-offs used ids like "12-small", "12-large".
// If any legacy id for a gift's position is ticked, that gift counts as written (unless an
// explicit tick/untick on the new id says otherwise), so Olivia is never asked to redo a name.
export function buildQueue(events) {
  const startIdx = events.map((e) => e.type).lastIndexOf('start');
  if (startIdx === -1) return [];
  const items = [];
  const explicit = new Map(); // new-style id -> done
  const legacy = new Map(); // log position -> Set of ticked legacy ids
  const isDone = (id) => {
    if (explicit.has(id)) return explicit.get(id);
    return (legacy.get(id)?.size ?? 0) > 0;
  };
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'ornament_check') {
      const id = String(e.itemId);
      if (/^\d+$/.test(id)) explicit.set(id, !!e.done);
      else {
        const pos = id.split('-')[0];
        const set = legacy.get(pos) ?? new Set();
        if (e.done) set.add(id); else set.delete(id);
        legacy.set(pos, set);
      }
      continue;
    }
    if (e.type !== 'gift' && e.type !== 'adjust') continue;
    const value = Math.abs(e.coins);
    const size = value >= LARGE_MIN ? 'large' : value >= MIN_GIFT ? 'medium' : null;
    if (!size) continue;
    if (e.coins >= 0) {
      items.push({ id: String(i), userId: e.userId, nickname: e.nickname, size, coins: e.coins, ts: e.ts });
    } else {
      for (let j = items.length - 1; j >= 0; j--) {
        const it = items[j];
        if (it.userId === e.userId && it.size === size && !isDone(it.id)) { items.splice(j, 1); break; }
      }
    }
  }
  return items.map((it) => ({ ...it, done: isDone(it.id) }));
}
