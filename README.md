# TikTok LIVE giveaway tracker

Counts coins per viewer from TikTok LIVE gifts, awards stacking ornaments (1,000+ small, 5,000+ medium, 10,000+ large) and draws one $100 gift card winner weighted by coins.

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

## Leaderboard page
`docs/index.html` is static. Set `API` near the bottom to your server URL, then enable GitHub Pages on the `/docs` folder.

## Notes
- TikTok has no official gift webhook; this uses the unofficial `tiktok-live-connector`, which can break when TikTok changes things. Test on a real stream first.
- Coins are counted as the gift's `diamondCount` x repeat count, assumed equal to the coin price. Verify against a real test gift.
- `data/events.jsonl` is the append-only source of truth; state is rebuilt from it on restart.
