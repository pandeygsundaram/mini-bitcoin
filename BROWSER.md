# Mini-Bitcoin browser network

Branch: `feat/browser-runtime`.

The wallet, validating node engine, and proof-of-work execute locally in Rust/WASM.
Mining uses dedicated Web Workers. The frontend is static and can be hosted on
Vercel. A separate small discovery/signaling service introduces browsers to one
another; WebRTC carries their blockchain messages.

This is an educational network, with its own tokens and genesis. It does not
connect to Bitcoin or the existing native mini-bitcoin v1 network.

## Run locally

Requirements: Node.js 22+, Rust/rustup, and internet access for the first Rust
build. The JavaScript application and signaling server have no npm dependencies.

From the repository root:

```sh
npm run build
npm test
npm run test:core
npm run test:wasm
npm run dev
```

Open **http://localhost:8080**. The build installs the WASM target if needed. If
Cargo is absent (for example on Vercel), the build script installs a minimal Rust
toolchain inside the ignored `.build/` directory without changing your shell profile.

1. Create a wallet, choose an optional local name and a password, and export an
   encrypted backup from Wallet. Alternatively import an encrypted browser backup
   or a raw 32-byte secp256k1 private key as 64 hex characters.
2. In Node, click **Start node**.
3. In Miner, select **This browser node** or Automatic. For a first node with no
   peers, explicitly enable **Allow mining with no connected node peers**.
4. Start mining. Rewards from height H can be spent in a block at height H+2.
5. Open a second tab. It can unlock a saved wallet or create another one. Each tab
   remembers its chosen wallet; creating a wallet does not delete the others.
6. Copy the recipient address, send from the funded wallet, and mine another block.
   The recipient can follow pending and confirmed activity without advertising a node.

Default local mode uses BroadcastChannel between tabs in the same browser/storage
partition. Separate browser profiles and devices require global discovery below.

Names, private keys and passwords are never sent to discovery or peers. The public
reward/recipient addresses necessarily appear in transaction data. Wallet secrets
are encrypted with AES-GCM and a PBKDF2-derived password key; unlocked keys live in
the page and signing worker, never in mining workers. Native `.priv.cbor` files
and native chain backups are not browser-v2 backup files.

## Deploy the frontend on Vercel

Import this repository and select `feat/browser-runtime` as the deployment branch.
Use the **repository root**, framework **Other**, build command `npm run build`,
and output directory `dist`. These settings are already in `vercel.json`.

Optional public build environment variables:

| Variable | Meaning |
| --- | --- |
| `MINI_DISCOVERY_URL` | HTTPS URL of your deployed signaling service |
| `MINI_ICE_SERVERS` | JSON array of additional RTCIceServer configurations; default `[]` |

You can instead enter the service URL and ICE configuration in Connections. Browser
settings override the build defaults. Keep TURN shared authentication secrets on
the service, never in Vercel frontend variables or public ICE JSON.

The build requires outbound access to Rust's distribution servers and crates.io.
Vercel serves the application; each visitor's device runs their node/miner. This
frontend deployment does not itself run an always-online full node.

## Connect different devices

Run the included signaling server on a Node.js host that supports long-running
HTTP requests/SSE. Put it behind HTTPS; an HTTPS frontend cannot call an HTTP service.

```sh
cp .env.example .env
# Edit .env: set the actual frontend origin and your ICE services.
node --env-file=.env signaling/server.mjs
```

For local development, `npm run signaling` uses port 8787 and allows
`http://localhost:8080` and `http://127.0.0.1:8080`. Enter
`http://localhost:8787` in Connections in both browsers.

A Docker deployment is also included:

```sh
docker build -f signaling/Dockerfile -t mini-bitcoin-signaling .
docker run --rm --env-file .env -p 8787:8787 mini-bitcoin-signaling
```

Configure these service variables:

| Variable | Meaning |
| --- | --- |
| `ALLOWED_ORIGINS` | Comma-separated exact frontend origins, including scheme; add preview origins explicitly |
| `STUN_URLS` | Comma-separated STUN URLs from your chosen provider |
| `TURN_URLS` | Comma-separated TURN/TURNS URLs |
| `TURN_SECRET` | Matching coturn REST shared secret; produces one-hour peer credentials |
| `PORT` | Listening port; default 8787 |
| `MAX_PEERS` | Discovery capacity; default 500 |

STUN alone will not connect every combination of networks. Configure TURN for
relay fallback. The app can accept short-lived provider credentials through its
additional ICE settings as well. A signaling server restart loses presence only;
it never stores wallet secrets or chain history. Existing connections may need
to reconnect and synchronize. This single-instance service intentionally keeps
presence in memory; horizontal replicas require shared presence/message routing.

The service exposes `/health`, `/v1/register`, `/v1/events` (authenticated SSE),
`/v1/presence`, `/v1/signal`, and `/v1/leave`. It carries peer roles, reported height,
and connection setup information. It does not approve blocks or transactions.
Signals are queued briefly when a receiving peer has not attached its stream.
Presence expires after roughly 35 seconds; counts are approximate recent reports,
not a cryptographically established count of all participants.

Keep a browser tab running as a seed if desired. There is no elected master node.
Browser suspension, device sleep, and tab closure interrupt availability. If all
nodes leave, the network pauses; a returning saved node can serve its history.
At least one copy of the history or an exported chain backup must survive.

## Architecture and protocol

- `browser-core/`: independent Rust library plus a tiny JSON-over-WASM ABI. Owns
  secp256k1 key derivation/signatures, exact integer amounts, transaction creation,
  UTXOs, mempool validation, block templates, hashing, PoW, fork selection and replay.
- `web/src/core.worker.js`: runs the node/wallet engine off the UI thread.
- `web/src/miner.worker.js`: bounded nonce batches with progress, cancellation,
  persistent nonce progress and disjoint worker strides.
- `web/src/network.js`: local channels, discovery client, WebRTC negotiation,
  bounded fragmentation, backpressure and reconnect handling.
- `web/src/storage.js`: encrypted wallet profiles, IndexedDB and atomic
  highest-work history saves. A stale tab cannot overwrite a better saved chain.
- `signaling/server.mjs`: dependency-free rendezvous service with origin checks,
  session-based signaling, bounded requests/queues and presence expiry.

The legacy workspace remains intact. Its first-block handling, signatures and
chain-selection assumptions differ from the browser requirements. The browser
therefore has an explicit **v2** protocol and does not import the permissive v1
`Blockchain` implementation. It ports the same UTXO/secp256k1/PoW concepts into a
stricter engine. Native CLIs retain their existing TCP/CBOR protocol; browser-v2
uses deterministic JSON structures and exact decimal integer strings for amounts
and nonces. Native v1 and browser v2 do not interoperate.

Consensus parameters: fixed genesis anchor, initial 16 leading-zero difficulty
bits, bounded 12–24 bits, adjustment every 20 blocks toward 10-second intervals,
50 MINI initial reward halving every 210 heights, and reward maturity of two
heights. A block contributes `2^bits` accumulated work. Equal-work branches break
ties by lexicographically smaller tip hash. Every accepted/restored branch is
validated; serialized balances, UTXOs and reported work are never trusted.
Signatures bind the network, ordered inputs/public keys, outputs, nonce and input
index. Confirmed and pending input conflicts are rejected. Unconfirmed outputs
cannot be spent in this first version. Transactions are selected deterministically
by transaction ID, without fee prioritization.

On a reorganization, the engine rebuilds UTXOs from the winning branch and
reconsiders abandoned transactions. Invalid/conflicting spends drop out. Wallet
confirmations follow the active branch; recently tracked outgoing payments that
leave it are marked accordingly. An online seed improves discovery and history
availability, but does not guarantee finality or prevent competing mining.

Automatic mining prefers the local node when no synchronization is in progress,
otherwise a connected remote node (up-to-date candidates first, then measured
round-trip latency). Remote-provider claims are not a trust guarantee: miners
check network, reward destination, parent, height and expected difficulty against
their validated local history. Local nodes validate complete submitted blocks.
Provider loss triggers retry/failover. Node sync happens before mining; isolated
local mining requires explicit opt-in.

## Verification

```sh
npm test
cargo test --manifest-path browser-core/Cargo.toml --release
npm run build
npm run test:wasm
```

The Rust tests cover signed payments, signature tampering, duplicate/conflicting
spends, maturity, bad targets/networks, fork convergence and corrupt backup
atomicity. The WASM smoke test executes the actual exported ABI in Node.

Optional browser checks (also configured in `.github/workflows/browser.yml`):

```sh
npm install --no-save --package-lock=false playwright@1.56.1
npx playwright install chromium
node scripts/test-browser.mjs
node scripts/test-global-browser.mjs
```

The first checks actual workers, mining, two local wallets, transfer and reload.
The second uses isolated browser profiles, signaling and actual WebRTC for remote
mining and payment propagation. It uses host ICE candidates on one machine;
a real two-network test is still needed to verify your STUN/TURN deployment.

Implementation-environment verification: eight JavaScript tests passed, as did
JavaScript syntax checks and Rust formatting. Rust compilation, actual WASM
execution and browser end-to-end tests could not run in that environment: k256
and the WASM target were unavailable, outbound DNS was blocked, and listening
sockets were disallowed. The CI workflow is supplied to run these checks in a
network-enabled environment; its passing status has not been observed here.

## Current bounds

This implementation is for a small educational network. It stores up to 10,000
blocks (including side branches), 1,000 pending transactions, 100 transfers per
block, 64 KB per transaction, 900 KB per block and eight WebRTC connections per
browser. Snapshots/branches are validated by replay; large histories have
quadratic import cost. Optimized state snapshots, headers-first synchronization,
pruning, fee-based ordering and production Sybil/abuse defenses are future work.
A small PoW network can be reorganized cheaply; confirmations are probabilistic.

The home screen reports discovery-scoped roles, local chain height and observed
block intervals. Confirmation time is a rough backlog/block-interval estimate,
not a guarantee and not inferred from miner count alone.
