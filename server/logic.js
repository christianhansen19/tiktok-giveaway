import { createHash } from 'node:crypto';

// RULES
// 1. Ornaments are earned PER SINGLE GIFT (a streak counts as one gift at its total):
//      gift >= 1,000 coins  -> 1 small
//      gift >= 5,000 coins  -> + 1 medium
//      gift >= 10,000 coins -> + 1 large
//    A big gift stacks: one 16,000-coin gift = small + medium + large.
//    Two separate 1,500-coin gifts = 2 small.
// 2. Draw entries come from ornaments: 1 per small, 5 per medium, 10 per large.
//    A viewer's chance to win = their entries / all eligible entries.
export const TIERS = [
  { key: 'small', min: 1000, entries: 1 },
  { key: 'medium', min: 5000, entries: 5 },
  { key: 'large', min: 10000, entries: 10 },
];

// Ornaments earned by ONE gift worth `coins`.
export function rewards(coins) {
  const out = { small: 0, medium: 0, large: 0 };
  for (const t of TIERS) if (coins >= t.min) out[t.key] = 1;
  return out;
}

// Draw entries represented by a set of ornament counts.
export function entriesOf(orn) {
  return TIERS.reduce((s, t) => s + Math.max(orn[t.key] ?? 0, 0) * t.entries, 0);
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
// events: gift {coins} = one gift; adjust {coins} = add one gift of that size (positive)
// or remove a mistakenly counted gift of that size (negative).
export function aggregate(events, excluded = new Set()) {
  const byUser = new Map();
  for (const e of events) {
    if (e.type !== 'gift' && e.type !== 'adjust') continue;
    const u = byUser.get(e.userId) ?? {
      userId: e.userId, nickname: e.nickname, coins: 0, orn: { small: 0, medium: 0, large: 0 },
    };
    const sign = e.coins < 0 ? -1 : 1;
    const r = rewards(Math.abs(e.coins));
    for (const t of TIERS) u.orn[t.key] += sign * r[t.key];
    u.coins += e.coins;
    if (e.nickname) u.nickname = e.nickname; // latest nickname wins
    byUser.set(e.userId, u);
  }

  const viewers = [...byUser.values()].filter((u) => u.coins > 0).map((u) => {
    const rw = Object.fromEntries(TIERS.map((t) => [t.key, Math.max(u.orn[t.key], 0)]));
    return { ...u, rewards: rw, entries: entriesOf(rw), eligible: !excluded.has(u.userId) };
  });
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

// ORNAMENT QUEUE: one item per ornament, oldest first, for the current giveaway.
// Items are derived from the event log, so nothing is stored twice:
//  - each gift / positive manual adjust adds the ornaments that single gift earns
//  - a negative manual adjust cancels the latest still-unwritten ornament of that size
//    for that viewer (a gift counted by mistake disappears from the list)
//  - `ornament_check` events mark an item written / un-written (last event wins)
// Item ids are "<position in the full log>-<size>". The log is append-only, so ids never change.
export function buildQueue(events) {
  const startIdx = events.map((e) => e.type).lastIndexOf('start');
  if (startIdx === -1) return [];
  const items = [];
  const done = new Map();
  for (let i = startIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === 'ornament_check') { done.set(e.itemId, !!e.done); continue; }
    if (e.type !== 'gift' && e.type !== 'adjust') continue;
    const r = rewards(Math.abs(e.coins));
    for (const t of TIERS) {
      if (!r[t.key]) continue;
      if (e.coins >= 0) {
        items.push({ id: `${i}-${t.key}`, userId: e.userId, nickname: e.nickname, size: t.key, coins: e.coins, ts: e.ts });
      } else {
        for (let j = items.length - 1; j >= 0; j--) {
          const it = items[j];
          if (it.userId === e.userId && it.size === t.key && !done.get(it.id)) { items.splice(j, 1); break; }
        }
      }
    }
  }
  return items.map((it) => ({ ...it, done: done.get(it.id) === true }));
}
