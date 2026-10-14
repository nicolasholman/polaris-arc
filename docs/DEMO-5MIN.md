LEAD: RUN THESE
- `node scripts/e2e-browser-video-5min.mjs` (from this repo in the shared Arc workspace)
- `node ../video/scripts/render-5min-A.mjs polaris-5min`

Five-minute mainnet demo: `../video/out/polaris-5min.mp4`, timeline JSON, narration JSON and REVIEW beside it.
300 seconds, 1920×1080, 30 fps; 695 narration words supplied as text. No voice generated.
Post-render check: 25 successful receipts, 0 intentional failures; exact fees verified.
Hosted page and explorer browser checks passed. Receipt proof: [DEMO-5MIN-RECEIPTS.json](DEMO-5MIN-RECEIPTS.json).
- Original mainnet payment footage plus new read-only merchant/account tour.
- Local SQLite merchant API with production Privy relayer.
- Historical active plan footage labelled; cleanup receipts ingested for fresh views.
- No new mainnet transactions or paid API calls for recut.
- Claim bearer QR concealed; no voice generated.
Refreshed local ledger from real cleanup receipts; zero demo debt/collateral, subscription cancelled.
Existing browser-audit refresh was preserved separately, including its original hosting errors.
