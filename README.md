# Langclaw Backend

Node.js HTTP API for **Langclaw Sui Alpha**. The backend powers
Sui-first research, wallet/API authentication, Supabase persistence, usage
billing, automation, strategy backtests, and on-chain proof records.

The product, billing, and proof surface targets Sui mainnet. Non-Sui chains are
available only as optional analysis targets in the on-chain tools layer.

**Default product chain:** Sui mainnet
**Default billing asset:** SUI
**Main proof contract:** Sui `LangclawRegistry`

## Responsibilities

- Run Sui Intelligence through `runLangclawWorkflow(topic)`.
- Stream direct chat and research responses through `POST /api/chat/stream`.
- Enforce wallet session or API-key auth for account-scoped routes.
- Require linked Telegram account before chat/research agent runs.
- Reserve, settle, refund, and report internal usage balance.
- Verify SUI deposits into `LangclawUsageVault`.
- Orchestrate providers: Surf, Dune, Brave, Elfa, GitHub, Tavily, HackQuest,
  DEX Screener, DeFiLlama, Alchemy, explorer APIs, CoinGecko, GeckoTerminal,
  GoPlus where supported, and local synthesis.
- Produce deterministic `signals`, `report`, `alphaSignal`, `providerTrace`,
  final answer, usage receipt, and proof metadata.
- Record agent decisions through `LangclawRegistry` when proof env is configured.
- Record Strategy Lab backtests and paper trades through
  `LangclawTradingJournal` when journal env is configured.
- Maintain Sui eligibility and verification scripts.

## Local Setup

```bash
cp .env.example .env
npm install
npm run dev
```

The backend package listens on `http://localhost:3001` unless `PORT` is set.

```bash
curl http://localhost:3001/health
```

Build and run production output:

```bash
npm run build
npm start
```

The frontend proxy defaults to `LANGCLAW_BACKEND_REWRITE_URL=http://127.0.0.1:3002`.
If you are running this backend locally through `npm run dev`, either set the
frontend rewrite to `http://127.0.0.1:3001` or run this backend with `PORT=3002`.

## HTTP Routes

Routes are registered in [`src/server.ts`](src/server.ts).

| Area | Routes |
| --- | --- |
| Health | `GET /health` |
| Wallet auth | `POST /api/wallet/challenge`, `POST /api/wallet/session` |
| Chat | `POST /api/chat/stream`, `POST /api/chat/sessions` |
| Research | `POST /api/discover`, `POST /api/discover/stream` |
| API keys | `POST /api/api-keys` |
| Memory | `POST /api/memory`, `POST /api/memory/settings` |
| Watchlist | `POST /api/watchlist` |
| Usage | `POST /api/usage/balance`, `POST /api/usage/quote`, `POST /api/usage/vault`, `POST /api/usage/deposit/verify`, `POST /api/usage/withdraw/request` |
| Automation | `POST /api/automation/tasks`, `POST /api/automation/runs`, `POST /api/automation/settings`, `POST /api/automation/notifications`, `POST /api/automation/telegram/webhook`, `POST /api/automation/webhooks/:slug` |
| Proof | `POST /api/proofs/decisions`, `POST /api/proofs/readiness` |
| Strategy Lab | `POST /api/strategy/scan-pairs`, `POST /api/strategy/backtest`, `POST /api/strategy/paper-trade`, `POST /api/strategy/runs` |

Full request/response shapes: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md).

## Research Workflow

```text
request
  -> account auth and Telegram link gate
  -> usage reservation for research mode
  -> Sui chain resolver
  -> OpenClaw planner and reasoning steps when available
  -> TypeScript provider calls and on-chain tools
  -> normalized source cards and tool results
  -> deterministic structured report and alpha quality scoring
  -> final answer synthesis through OpenAI / OpenClaw AI / deterministic fallback
  -> evidence bundle and optional Sui proof anchoring
  -> usage settlement or refund
```

Output contracts are stable and additive:

- `signals.social`, `signals.onchain`, and `signals.combined` are always present.
- `report` is the preferred UI rendering object for ranked entities, tables,
  caveats, recommendations, and narrative sections.
- `alphaSignal` contains quality score, alert eligibility, source coverage, and
  false-positive checks.
- `providerTrace` shows which providers succeeded, failed, skipped, or were out
  of scope.
- `proof` contains storage, chain, and compute metadata.

## Model Behavior

The frontend currently sends the fixed chat model `gpt-5.4-nano`.

Backend defaults are environment-driven:

```bash
OPENAI_CHAT_MODEL=gpt-5-mini
OPENAI_AGENT_MODEL=gpt-5.2
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_TIMEOUT_SECONDS=90
```

Direct chat honors a supported `body.model`; agent mode passes the requested
model into the Langclaw workflow. If no model is supplied, the backend uses the
configured defaults above, and proof metadata reports requested and used model
fields.

## Environment

Copy [`.env.example`](.env.example). Minimum useful local values:

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Persistence and server-side writes |
| `LANGCLAW_API_KEY_PEPPER` | API-key hashing |
| `LANGCLAW_WALLET_SESSION_SECRET` | Wallet session signing |
| `OPENAI_API_KEY` | Direct chat and final answer synthesis |
| `CORS_ORIGIN` | Frontend origin, usually `http://localhost:3000` |

Core Sui values:

```bash
SUI_CHAIN_ENABLED=true
SUI_INTEL_PROOF_ENABLED=true
SUI_CHAIN_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_NETWORK=mainnet
SUI_CHAIN_EXPLORER_URL=https://suivision.xyz
SUI_LANGCLAW_REGISTRY_PACKAGE_ID=
SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID=
SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID=
SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID=
SUI_LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID=
SUI_AGENT_PRIVATE_KEY=
SUI_AGENT_ID=133
```

Provider keys:

```bash
BRAVE_SEARCH_API_KEY=
TAVILY_API_KEY=
GITHUB_TOKEN=
SURF_ENABLED=false
SURF_API_KEY=
SURF_CLI_FALLBACK_ENABLED=true
ELFA_ENABLED=false
ELFA_API_KEY=
DUNE_API_KEY=
DUNE_STRATEGY_QUERY_ID=
ALCHEMY_API_KEY=
ETHERSCAN_API_KEY=
GOPLUS_API_KEY=
GOPLUS_API_SECRET=
COINGECKO_API_KEY=
```

Provider routing is Sui-first. Surf is the primary smart-money provider when
enabled, Surf CLI can act as a fallback, Dune supplies row-level SQL fallback and
Strategy Lab history, Elfa adds social intelligence when configured, and Nansen
is retained only where the selected analysis chain is supported. GoPlus is
skipped in this workflow when the live provider does not support the chain.

The Sui usage vault is the shared `LangclawUsageVault` object on Sui mainnet and
accepts native SUI deposits; no ERC-20 deposit-token address is required.

## Smart-Money Behavior

Smart-money requests preserve user scope before selecting providers:

- `Find smart-money accumulation on Sui` remains chain-level.
- `Find smart-money accumulation for SUI on Sui` may use token-specific
  context.
- Sui chain activity is not treated as Ethereum token activity.
- DEX-only rows are large-flow watchlist entries, not confirmed smart-money
  wallets.
- Confirmed smart money requires wallet labels plus retention or behavior checks.
- Stablecoins and wrapped majors are bucketed separately from non-stable token
  accumulation.
- Final answers hide raw HTTP details, billing internals, CLI flags, and provider
  stack traces from end users.

## Usage Billing

Usage is internal ledger-based billing:

1. User deposits SUI into `LangclawUsageVault`.
2. `POST /api/usage/deposit/verify` verifies the vault `Deposit` event.
3. Backend credits the Supabase usage ledger.
4. Research/chat agent requests reserve balance before work starts.
5. Successful runs settle cost from model/provider usage metadata.
6. Failed runs refund the reservation where possible.
7. `POST /api/usage/withdraw/request` returns withdrawal authorization details
   for available balance.

Sui transactions are paid in native SUI gas; the agent recorder wallet signs
proof and journal transactions on Sui mainnet.

## Strategy Lab

Strategy Lab is a proof-backed backtesting module, not live trading.

- `scan-pairs` ranks Sui pairs from Dune historical rows.
- `backtest` runs the Sui Liquidity Momentum Strategy over Dune rows.
- `paper-trade` creates deterministic paper orders from the latest signal.
- `runs` reads `LangclawTradingJournal` records for Proof Center.

Required proof env:

```bash
SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID=0x95cdf14e4b313ff45af3188d47c8a04ba392d985173910912166b0bf59d6c1e6
SUI_TRADING_JOURNAL_ENABLED=true
LANGCLAW_STRATEGY_EVIDENCE_BASE_URI=langclaw://strategy
```

Without journal config, Strategy Lab still returns backtest data and an honest
`prepared` proof state.

## Current Sui Verification

| Item | Current value |
| --- | --- |
| Sui network | `mainnet` |
| Package ID (`decision_registry`, `trading_journal`, `usage_vault`, `memory_registry`) | [`0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5`](https://suivision.xyz/package/0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5) |
| `LangclawUsageVault` shared object | [`0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff`](https://suivision.xyz/object/0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff) |
| AdminCap object | [`0x21314b9534ca673cac1c79d6d1a63b9b0469d684504c974d3e8a5588873e8d09`](https://suivision.xyz/object/0x21314b9534ca673cac1c79d6d1a63b9b0469d684504c974d3e8a5588873e8d09) |
| Deployer / agent / recorder wallet | [`0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622`](https://suivision.xyz/account/0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622) |
| Agent ID | `133` |
| Package publish tx | [`6kmuA94JsgM7uJ7MN32WEbWFMkF5rBuLUrUwFT4eTKED`](https://suivision.xyz/txblock/6kmuA94JsgM7uJ7MN32WEbWFMkF5rBuLUrUwFT4eTKED) |
| Vault setup tx | [`ALvypw6EvadDXo4MCzgNEPgLJ8jES3rVLsWZHCnnqYVH`](https://suivision.xyz/txblock/ALvypw6EvadDXo4MCzgNEPgLJ8jES3rVLsWZHCnnqYVH) |

Recheck from this folder:

```bash
npm run check:eligibility
npm run check:sui-proof
```

RPC connectivity uses `https://fullnode.mainnet.sui.io:443`. Mainnet object
reads pass only after the package and vault ids are configured.

## Current Walrus Verification

Each `/api/discover` run stores its Seal-encrypted evidence artifact on Walrus,
then **re-fetches the blob and hash-compares it** (store -> read-back -> verify) so
the emitted `walrusMemory` proof can honestly claim the memory is retrievable,
not merely "uploaded". The proof carries `walrusBlobId`, a public
`walrusBlobUrl` (aggregator GET), `hashVerified`, the Seal mode, and the Sui
anchor; the UI renders these as clickable, independently retrievable links.

Mainnet config:

```bash
WALRUS_AGGREGATOR_URL=https://aggregator.walrus-mainnet.walrus.space
WALRUS_PUBLISHER_URL=
WALRUS_EPOCHS=5
```

Walrus mainnet does not expose a public unauthenticated publisher endpoint in
the official network reference. Set `WALRUS_PUBLISHER_URL` to your own
authenticated publisher or upload relay before expecting public blob writes.
With publisher unset, the backend uses the local fallback and reports
`walrusStorageMode: local` honestly.

| Layer | Mainnet status |
| --- | --- |
| Walrus aggregator | configured: `https://aggregator.walrus-mainnet.walrus.space` |
| Walrus publisher | pending authenticated publisher or upload relay |
| Seal mode | `local-envelope` unless `SEAL_MOCK_MODE=false`, the mainnet package id, and a mainnet key server config are set |
| MemWal | optional, uses `https://relayer.memory.walrus.xyz` when configured |
| Sui memory anchor | pending mainnet package publish and `SUI_REGISTRY_PACKAGE_ID` |

> Note: a blob URL is published **only** in `http` mode; in `local` fallback the
> proof honestly reports `walrusStorageMode: local` and exposes no public URL.

Reproduce / recheck from this folder:

```bash
# Full pipeline against mainnet (stores on Walrus + anchors on Sui) + independent
# aggregator GET:
node --import tsx --env-file=.env scripts/walrus-mainnet-proof.ts "your topic"

# Recall-from-chain: rebuild an owner's memory pointer index purely from Sui
# `MemoryRecorded` events (portable — no local index needed):
node --import tsx --env-file=.env scripts/memory-recall-from-chain-proof.ts

# Adapter-mode + latest-blob durability readiness:
npm run check:walrus-readiness
```

The readiness check reports the live Walrus / Seal / MemWal adapter modes and, in
`http` mode, retrieves the latest encrypted memory blob back from the aggregator
to confirm durability.

### Recall-from-chain (portability)

Recall no longer depends on the local on-disk index. `recallMemories`
(`src/lib/memory-workflow.ts`) merges pointers reconstructed from Sui
`MemoryRecorded` events (`src/lib/sui-memory-index.ts`) — so a fresh device with
an empty index recovers an owner's encrypted-memory pointers straight from chain.
On mainnet this becomes active after the memory registry package is published and
`SUI_REGISTRY_PACKAGE_ID` is configured.

The chain restores the *verifiable pointers*; **decrypting** the content on a
different device is handled by real Seal (`seal-sdk-configured`) when the
mainnet Seal package and a mainnet key server config are set. The owner's
SessionKey unlocks a key share through the `access_policy::seal_approve` owner
gate, so the AES key is no longer machine-local.

Mainnet Seal setup:

```bash
SUI_NETWORK=mainnet
SUI_RPC_URL=https://fullnode.mainnet.sui.io:443
SEAL_MOCK_MODE=false
SEAL_PACKAGE_ID=0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5
SEAL_KEY_SERVER_OBJECT_IDS=<provider-issued-mainnet-key-server-object-id>
SEAL_KEY_SERVER_API_KEY_NAME=<provider-api-key-header-name>
SEAL_KEY_SERVER_API_KEY=<provider-api-key>
SEAL_THRESHOLD=1
```

Self-host Open mode uses the same backend env shape. Register an independent
key server with the official Seal `key_server` package, run it with the matching
master key, and put the created `KeyServer` object id in
`SEAL_KEY_SERVER_OBJECT_IDS`. Open mode does not need
`SEAL_KEY_SERVER_API_KEY_NAME` or `SEAL_KEY_SERVER_API_KEY`. Use a stable public
HTTPS URL for a public demo; a temporary tunnel is only suitable for local proof.

For multiple providers, or when each provider uses different auth, prefer the
JSON form:

```bash
SEAL_KEY_SERVER_CONFIGS_JSON='[{"objectId":"0x...","weight":1,"apiKeyName":"x-api-key","apiKey":"..."}]'
```

The public decentralized committee key server for mainnet is not self-serve yet.
Use a verified independent mainnet provider such as Enoki, Ruby Nodes,
NodeInfra, Overclock, Studio Mirai, H2O Nodes, Triton One, or Natsai, or run a
self-host independent server when you can keep the key and URL stable.

> **Upgrade gotcha (important).** Both Seal (`SEAL_PACKAGE_ID`) and the
> recall-from-chain event query (`SUI_REGISTRY_EVENT_PACKAGE_ID`) must use the
> registry's **first-version / original-publish** package id
> from the mainnet publish, not a later upgraded runtime id. Seal rejects a
> non-first-version package and `MemoryRecorded` events are typed by the defining
> package. Set `SEAL_MOCK_MODE=true` (or omit the key server config) to
> fall back to the offline `local-envelope` AES mode, and
> `SUI_MEMORY_RECALL_FROM_CHAIN=false` to disable chain recall.

## Smart Contracts

All product contracts are Move modules published in a single Sui package on
mainnet (package ID configured after publish).

| Move module | Purpose | Env |
| --- | --- | --- |
| `usage_vault` | Usage deposits / settlement vault (shared object) | `SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID`, `SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID`, `SUI_LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID` |
| `decision_registry` | Agent decision proof records | `SUI_LANGCLAW_REGISTRY_PACKAGE_ID` |
| `trading_journal` | Strategy Lab backtest / paper-trade records | `SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID`, `SUI_TRADING_JOURNAL_ENABLED` |
| `memory_registry` | Agent memory anchoring | `SUI_LANGCLAW_REGISTRY_PACKAGE_ID` |

Related contract docs:

- Vault spec: [`docs/SMART_CONTRACT_TEAM_NOTES.md`](docs/SMART_CONTRACT_TEAM_NOTES.md)
- Eligibility runbook: [`docs/SUI_ELIGIBILITY.md`](docs/SUI_ELIGIBILITY.md)

## Scripts

```bash
npm run dev
npm run build
npm start
npm run typecheck
npm test
npm run check:sui-proof
npm run dune:create-strategy-query
npm run smoke:strategy-lab
npm run check:walrus-readiness
npm run smoke:memwal
npm run demo:walrus-public
npm run smoke:deposit-dryrun
```

## Related Docs

| File | Description |
| --- | --- |
| [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) | Full backend API reference |
| [`docs/SUI_ELIGIBILITY.md`](docs/SUI_ELIGIBILITY.md) | Sui eligibility status and command runbook |
| [`LANGCLAW_BLUEPRINT.md`](LANGCLAW_BLUEPRINT.md) | Product, demo, and proof blueprint |
| [`docs/HACKATHON_SUBMISSION.md`](docs/HACKATHON_SUBMISSION.md) | Submission narrative |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | Demo video script |
| [`docs/SMART_CONTRACT_TEAM_NOTES.md`](docs/SMART_CONTRACT_TEAM_NOTES.md) | Contract responsibilities and env contract |
