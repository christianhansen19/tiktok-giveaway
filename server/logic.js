import { createHash } from 'node:crypto';

// Reward thresholds. Rewards stack: 16,000 coins = small + medium + large.
export const TIERS = [
  { key: 'small', min: 1000 },
  { key: 'medium', min: 5000 },
  { key: 'large', min: 10000 },
];

export function rewards(coins) {
  const out = { small: 0, medium: 0, large: 0 };
  for (const t of TIERS) if (coins >= t.min) out[t.key] = 1;
  return out;
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

// Rebuild per-viewer totals from the event log (the log is the source of truth).
// events: [{type:'gift', userId, nickname, coins} | {type:'adjust', userId, nickname, coins}]
export function aggregate(events, excluded = new Set()) {
  const byUser = new Map();
  for (const e of events) {
    if (e.type !== 'gift' && e.type !== 'adjust') continue;
    const u = byUser.get(e.userId) ?? { userId: e.userId, nickname: e.nickname, coins: 0 };
    u.coins += e.coins;
    if (e.nickname) u.nickname = e.nickname; // latest nickname wins
    byUser.set(e.userId, u);
  }
  const total = [...byUser.values()].reduce((s, u) => s + Math.max(u.coins, 0), 0);
  // Excluded users (streamer, mods, bots) still appear on the board for rewards
  // but are removed from the draw pool.
  const poolTotal = [...byUser.values()]
    .filter((u) => !excluded.has(u.userId))
    .reduce((s, u) => s + Math.max(u.coins, 0), 0);
  return [...byUser.values()]
    .filter((u) => u.coins > 0)
    .sort((a, b) => b.coins - a.coins)
    .map((u, i) => ({
      rank: i + 1,
      userId: u.userId,
      nickname: u.nickname,
      coins: u.coins,
      rewards: rewards(u.coins),
      eligible: !excluded.has(u.userId),
      odds: !excluded.has(u.userId) && poolTotal > 0 ? u.coins / poolTotal : 0,
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

// Weighted draw: probability = coins / total coins of eligible viewers.
export function draw(board, seed) {
  const pool = board.filter((r) => r.eligible && r.coins > 0);
  const total = pool.reduce((s, r) => s + r.coins, 0);
  if (total <= 0) return null;
  const pick = seededRandom(seed)() * total;
  let acc = 0;
  for (const r of pool) {
    acc += r.coins;
    if (pick < acc) return { winner: r, seed, pick, total };
  }
  return { winner: pool[pool.length - 1], seed, pick, total };
}
