# TikTok LIVE giveaway tracker

Counts coins per viewer from TikTok LIVE gifts and draws one $100 gift card winner weighted by entries.

**Rules** (see `server/logic.js`): only a single gift of 1,000+ coins counts, and small gifts never add up. Each qualifying gift earns one ornament (1,000-9,999 coins = medium, 10,000+ = large) and 1 entry per 1,000 coins, rounded down (15,000 = 1 large ornament, 15 entries).

## Run the server
```bash
npm install
TIKTOK_USERNAME=streamerhandle ADMIN_TOKEN=pick-a-long-secret npm start
```
Optional env: `PORT`, `DATA_DIR` (keep on a persistent volume), `ALLOW_ORIGIN` (your GitHub Pages origin), `EXCLUDED_USER_IDS` (comma list: streamer, mods, bots; they stay on the board but are removed from the draw).

## Run a giveaway (replace URL and token)
```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $API/admin/start
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $API/admin/stop
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" $API/admin/draw
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"userId":"123","coins":500,"note":"missed gift"}' $API/admin/adjust
```
Gifts only count between `start` and `stop`. The draw seed is returned and stored so the result can be re-verified.

## Ornament queue (admin page)
Every ornament earned (one per ornament, oldest first) appears in the admin page's **Ornament queue**, so Olivia can write each name and tick it off. Ticks are saved in the server log, so they survive restarts and show on every device. Pressing Start for a new giveaway warns if ornaments are still unwritten. Endpoints: `POST /admin/queue` and `POST /admin/ornament {itemId, done}` (password required). Public: `GET /leaderboard` (viewers with entries, plus a short list of others), `GET /lookup?q=name` (search everyone), `GET /health`.

## Draw show (`docs/draw.html`)
A recordable reveal of the real draw for Discord. Stop the giveaway, open the draw show from the admin page, start a screen recording, press **Clean view**, then **Space**. The server picks the winner (saved, can't be redone; `POST /admin/draw` with `{"force": true}` overrides in an emergency). The page shows every entry as a slice of a bar, sweeps a pointer across it and lands on the server's exact pick, then recomputes the pick from the seed in the browser and shows "✓ Verified". **Replay the reveal** (`POST /admin/drawinfo`) re-shows the same result for another take. A **Practice run** uses current entries and a random seed, is watermarked PRACTICE, and picks nobody.

## Leaderboard page
`docs/index.html` is static. Set `API` near the bottom to your server URL, then enable GitHub Pages on the `/docs` folder.

## Notes
- TikTok has no official gift webhook; this uses the unofficial `tiktok-live-connector`, which can break when TikTok changes things. Test on a real stream first.
- Coins are counted as the gift's `diamondCount` x repeat count, assumed equal to the coin price. Verify against a real test gift.
- `data/events.jsonl` is the append-only source of truth; state is rebuilt from it on restart.
