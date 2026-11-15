# Continue the Mini-Bitcoin browser implementation

## Workstation continuation update (2026-11-15)

This update supersedes the original environment blockers recorded below.
SSH access was enabled and the agent cloned the bundle into
`/home/sundaram/data/super30/cohort-projects/mini-bitcoin-browser` on branch
`feat/browser-runtime`. The pre-existing `mini-bitcoin` checkout was not edited.
No user files or projects were deleted.

Verified here: 8 JS tests, 7 release Rust tests, release WASM build, real WASM
ABI smoke test, local browser wallet/mining/payment/reload test, global
isolated-profile signaling/WebRTC/remote-miner/payment test, and native workspace
`cargo check --workspace --locked`. All passed. The browser test runner was
updated to Playwright 1.65.1 for Ubuntu 26.04 support, and the browser Cargo.lock
was generated. Browser builds now use `--locked` for repeatable dependencies.

Use `git log` for the latest workstation commit. The old implementation and
handoff commits below remain historical references. Read the updated BROWSER.md
for current verification and deployment instructions. The outstanding deployment
step is configuring/hosting the separate HTTPS signaling and STUN/TURN services
and testing across physical networks; no production deployment was performed.


This is a task handoff, not a verbatim conversation transcript. Read this and
BROWSER.md, inspect the code, and continue the implementation and verification.
Do not restart the project or treat the existing source as fully verified.

## User's objective and accepted design

Turn the existing Rust educational mini-bitcoin project into a browser app.
Keep work on a separate branch. The user plans to host the frontend on Vercel.
They want actual Rust/WASM execution, not a simulated ledger or decorative UI.

User flow:
- Import a wallet or create a new wallet, with an optional local display name.
- Wallet section: send, receive, check balances and activity; backup/import.
- Node section: explicitly start/stop a validating node in the browser.
- Miner section: independently start/stop mining, choose CPU worker count and
  node provider. Can run wallet only, wallet+node, wallet+miner, or all three.
- Home screen: online node/miner reports, chain height, recent blocks, and a
  qualified estimate of confirmation time from observed blocks/backlog.
- One user's open browser tab can serve as a seed for other users. No consensus
  leader. Other synchronized nodes can continue serving if that seed leaves.
- Global discovery/signaling introduces peers. STUN assists NAT discovery;
  TURN relays when direct connections fail; WebRTC transports peer messages.
- A separate long-running service is accepted for discovery. A static Vercel
  frontend alone is not a public listening node or STUN/TURN service.

The user wants autonomous implementation, not repeated planning/permission asks.
They become frustrated by repeated instructions to manually retry blocked SSH.

## Repository and branch

Original local checkout:
`/Users/sakshi/Desktop/projects/rust/mini-bitcoin`

Branch: `feat/browser-runtime`.
Implementation commit: `063739413a6a2db07c52013e7413c6472b5c7b80`.

A complete-history Git bundle was created and verified:
`/Users/sakshi/Desktop/projects/rust/mini-bitcoin-browser.bundle`

The user reports copying that bundle to:
`/home/sundaram/data/super30/cohort-projects/mini-bitcoin-browser.bundle`
on workstation `sundaram@192.168.1.9`.

There is already another mini-bitcoin checkout on the workstation. Preserve it.
If not yet cloned, create the sibling browser checkout:

```sh
cd /home/sundaram/data/super30/cohort-projects
git clone -b feat/browser-runtime mini-bitcoin-browser.bundle mini-bitcoin-browser
cd mini-bitcoin-browser
```

The expected working directory on the workstation is therefore:
`/home/sundaram/data/super30/cohort-projects/mini-bitcoin-browser`.
Check actual directory/branch/status rather than assuming cloning has happened.
This handoff may have been copied separately after the original bundle transfer.

## Original project review

Native workspace has lib (btclib), node, miner, and good-wallet crates.
Native protocol uses length-prefixed CBOR over Tokio TCP. Node state is global.
Mining uses std::thread::spawn; wallet config/key and chain access use native files.
Original miner discards nonce progress between unsuccessful batches.

Original Blockchain implementation cannot be reused unchanged for global peers:
- First block skips key validation checks.
- Declared target is not checked against expected difficulty.
- Peer-block and mined-block UTXO updates differ.
- Only current-tip extensions are accepted; no fork/reorg handling.
- Mempool signature/conflict checking is incomplete.
- Native signatures cover only the referenced prior output, not destinations.

Decision implemented: retain native v1 entry points/data behavior and create an
explicit independent browser v2 engine. Browser v2 uses secp256k1 and UTXO/PoW
concepts but different signed payloads, fixed genesis, deterministic JSON wire
format, and strict validation. Native CBOR v1 and browser v2 do not interoperate.
This is explained in BROWSER.md. Never silently reinterpret native chain backups.

## Implementation present

- browser-core/: independent Rust workspace, cdylib+rlib; serde, serde_json,
  sha2, hex, k256 0.13.4 with defaults disabled and ecdsa+alloc features.
  Avoid k256 std feature: it can pull OS getrandom into the browser build.
- browser-core/src/lib.rs: wallet address derivation, full transaction signatures,
  exact checked integer money, UTXOs, mempool, block templates, PoW, Merkle roots,
  validated parent-linked block DAG, cumulative-work selection, deterministic
  equal-work tie-break, reorganization replay, snapshot validation/merge.
- WASM uses a small JSON ABI (allocate/request/response_len), NOT wasm-bindgen.
  No wasm-bindgen CLI is needed. Host supplies entropy and time; Rust owns crypto.
- web/: static JS/HTML/CSS app, core worker and dedicated mining workers.
  Dark green/lime dashboard with Overview, Wallet, Node, Miner, Connections tabs.
- web/src/network.js: local BroadcastChannel peers, remote discovery over HTTP/SSE,
  WebRTC DataChannels, fragmentation, backpressure, reconnect, setup timeout.
- web/src/storage.js: encrypted wallet profiles (PBKDF2/AES-GCM), per-tab selected
  wallet, IndexedDB chain backups, atomic best-work saves to protect against stale
  tabs overwriting better history. Wallet names remain local.
- web/src/app.js: controls, wallet activity, sync batches, transaction acknowledgments,
  remote miner requests/submissions, template cancellation, provider failover.
- signaling/server.mjs: dependency-free Node HTTP/SSE rendezvous service, expiring
  presence, per-session rate limits (registration IP limit), exact origin list,
  queued pre-SSE signals, optional one-hour coturn REST credentials.
- scripts/: Rust/WASM build, static packaging/dev server, WASM and browser smoke tests.
- vercel.json, .env.example, signaling/Dockerfile: deployment setup.
- .github/workflows/browser.yml: JS tests, Rust tests, build, real WASM test,
  local browser test and isolated-context global WebRTC/remote-miner test.
- BROWSER.md: full setup, architecture, protocol differences, limitations.

Network parameters: fixed genesis anchor, initial 16 leading-zero difficulty bits,
12–24 bit bounds, retarget every 20 blocks toward 10-second intervals; block work
2^bits, 50 MINI initial reward, halving every 210 heights, reward spendable in a
block two heights later. MAX 10k blocks including side branches, 1k pool txs,
100 transfers/block, 64 KB/tx, 900 KB/block, eight WebRTC links/browser.
Unconfirmed outputs cannot be spent. Templates select deterministic transaction-ID
order, not fee priority. Replay validation has quadratic large-history cost.

## Important explanations already given to the user

- Zero online peers pauses the network; it does NOT automatically reset history.
- Saved browser history or exported backups allow a returning node to restore it.
- Wallet private keys alone cannot reconstruct lost transaction history/balances.
- A 5 PM node cannot acquire an offline 8 PM node's newer blocks until some holder
  becomes reachable. If both mine separately, forks are reconciled by validated
  cumulative work, not wall-clock time or unverified reported height.
- Competing histories are selected, not merged into one combined spend history.
- Reorganizations can reverse confirmations/rewards; abandoned valid txs may return
  to the pool. Both conflicting spends cannot survive in one valid active chain.
- Always-online seed helps availability/connectivity, not guaranteed finality.
- Browser suspension/device sleep means an open tab is not an uptime guarantee.
- Miner count alone does not predict confirmation time; estimates are probabilistic.
- Miners prefer a synced local node; remote nodes are candidates by compatibility,
  validated history, responsiveness/latency, with manual override/fallback.

## What actually passed vs what has NOT run

Passed in original environment:
- Eight JS tests: exact amount parsing, input rejection, wallet encryption/password
  failure/tamper handling, local-tab discovery/chunked messaging/leaving, malformed
  fragment limits, signaling roles/origins, queued signals, presence/departure.
- All JS syntax checks, cargo fmt --check for browser-core, git diff --check.
- Git bundle verify; branch implementation committed, no source changes pending
  before this separately prepared handoff.

NOT verified; do not claim complete/deploy-ready until these pass:
- Actual Rust browser-core compilation/tests (k256 absent from local cache).
- WASM target compilation / actual ABI smoke test.
- Browser UI/worker end-to-end tests.
- Live HTTP server integration in original sandbox (listen EPERM).
- Real WebRTC/TURN connectivity across different physical networks.
- Native workspace compilation (existing dependencies missing from offline cache).

Original environment had no Node/npm on PATH. VS Code embedded Node 24 was used
for JS checks via ELECTRON_RUN_AS_NODE=1 with its Code executable. Rust was present,
but WASM target installation failed DNS/network access. Every SSH/SCP attempt to
192.168.1.9:22 failed 'Operation not permitted' BEFORE authentication. The user's
normal terminal SCP worked. No transfer/authentication success was observed by
agent tools, and no remote commands have been executed by the agent.

## Next actions on the workstation

1. Inspect git status/branch and installed Node/Rust versions. Read BROWSER.md.
2. Run npm test, npm run build, cargo test --manifest-path browser-core/Cargo.toml
   --release, and npm run test:wasm. Fix real compile/runtime failures first.
3. Run npm run dev and verify wallet create/unlock/import, node startup, isolated
   mining opt-in, reward maturity, transfer/confirmation, multiple wallets, reload.
4. Run browser tests with Playwright as documented. Test-global-browser uses
   isolated browser contexts + actual signaling/WebRTC + remote miner; it does
   not establish that NAT/TURN works across physical networks.
5. Review pending/reorg wallet status, relay/sync recovery, storage atomicity,
   large payload limits, and stopping/restarting roles.
6. Verify signaling externally with configured HTTPS origin and STUN/TURN.
7. Keep changes on this branch, commit fixes, and report exactly what was tested.
8. User will deploy Vercel frontend; no deployment credentials are needed merely
   to implement or verify. Do not publish or overwrite their existing checkout.

Useful commands:

```sh
npm test
npm run build
cargo test --manifest-path browser-core/Cargo.toml --release
npm run test:wasm
npm run dev
# Separate shell for global/local signaling:
npm run signaling
# Optional browser checks:
npm install --no-save --package-lock=false playwright@1.56.1
npx playwright install chromium
node scripts/test-browser.mjs
node scripts/test-global-browser.mjs
```

No SSH passwords, private keys, tokens or wallet secrets are included here.
