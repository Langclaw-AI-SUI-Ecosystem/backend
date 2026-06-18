# Langclaw API Reference

Backend base URL defaults to `http://localhost:3001`. In frontend local/proxy
mode the same API is usually reached through `/api/backend/*`.

## Authentication Model

Account-scoped routes accept either wallet session material in `body.wallet` or
the matching auth headers produced by the frontend wallet session helpers.

Research routes also require a linked Telegram chat in automation notification
settings. If the wallet is not authenticated the API returns `401`; if Telegram
is missing it returns `403`; if prepaid usage balance is insufficient it returns
`402`.

## Health

### `GET /health`

Returns:

```json
{
  "ok": true,
  "service": "langclaw-backend"
}
```

## Chat

### `POST /api/chat/stream`

Streams newline-delimited JSON. Direct chat calls OpenAI. Research mode runs the
Langclaw workflow, reserves usage balance, and can record selected-chain proof.

Request:

```json
{
  "message": "Find smart-money accumulation on Sui",
  "toolMode": "research",
  "chain": "sui-mainnet",
  "model": "gpt-5.4-nano",
  "wallet": {
    "address": "0x...",
    "sessionToken": "..."
  }
}
```

Important stream event types:

| Type | Meaning |
| --- | --- |
| `direct_reasoning_delta` | Direct-chat reasoning/status copy |
| `direct_delta` | Direct chat token delta |
| `direct` | Final direct chat payload |
| `mode` | Agent mode marker |
| `progress` | Workflow step progress |
| `tool_plan` | Planned on-chain tool calls |
| `tool_call` | Tool call started |
| `tool_result` | Tool call result |
| `result` | Final research payload |
| `error` | Stream failure |

Research `result.payload` includes:

- `signals.social`, `signals.onchain`, and `signals.combined`
- `report`
- `alphaSignal`
- `providerTrace`
- `finalAnswer`
- `usage`
- `proof`

Tool results can include additive metadata:

- `attemptedProviders`
- `fallbackReason`
- `scope`: `sui-premium`, `legacy-fallback`, `legacy-default`, or
  `out-of-scope`

### `POST /api/chat/sessions`

Creates, lists, loads, updates, and deletes wallet-scoped chat sessions.

The route uses an action-based body. Typical actions are `list`, `get`,
`upsert`, `update`, and `delete`.

## Research

### `POST /api/discover`

Runs the Sui Alpha workflow and returns one JSON payload.

Request:

```json
{
  "topic": "Rank Sui protocols by TVL and yield momentum",
  "wallet": {
    "address": "0x...",
    "sessionToken": "..."
  }
}
```

### `POST /api/discover/stream`

Streams workflow progress and then the final research payload. Use this when the
frontend needs step-by-step progress outside the chat session surface.

Both discover routes require account auth, linked Telegram, and sufficient usage
balance.

## Research Payload Contract

Example abbreviated payload:

```json
{
  "topic": "Detect liquidity anomalies on Sui DEX pairs",
  "signals": {
    "social": {
      "status": "partial",
      "summary": "Collected usable public context for Sui.",
      "providers": ["Surf", "Elfa"],
      "sourceIds": ["surf-web-0"],
      "toolIds": []
    },
    "onchain": {
      "status": "success",
      "summary": "Sui DEX pair evidence was available.",
      "providers": ["Dune", "DEX Screener"],
      "sourceIds": [],
      "toolIds": ["pair_liquidity.liquidity_pair_search"]
    },
    "combined": {
      "status": "partial",
      "summary": "On-chain evidence is usable, with social coverage caveats.",
      "providers": ["Surf", "Elfa", "Dune", "DEX Screener"],
      "sourceIds": ["surf-web-0"],
      "toolIds": ["pair_liquidity.liquidity_pair_search"]
    }
  },
  "report": {
    "kind": "liquidity-anomaly",
    "title": "Sui liquidity anomaly report",
    "asOfUtc": "2026-05-28T00:00:00.000Z",
    "executiveSummary": "The run found Sui pair movement worth review.",
    "bottomLine": "Treat this as a watchlist candidate until confirmed.",
    "confidence": "medium",
    "entities": [],
    "tables": [],
    "sections": [],
    "caveats": ["Some provider coverage was incomplete."],
    "recommendations": ["Confirm the pair with a second source."]
  },
  "alphaSignal": {
    "schema": "langclaw.alpha-signal.v1",
    "signalType": "liquidity-anomaly",
    "alertEligible": true,
    "quality": {
      "score": 82,
      "label": "high",
      "evidenceCount": 4,
      "sourceCoverage": {
        "social": true,
        "onchain": true,
        "directWalletFlow": false,
        "proof": true,
        "providerCount": 3
      },
      "falsePositiveChecks": [],
      "reasons": ["Quality score 82/100 is high."]
    }
  },
  "providerTrace": [
    {
      "provider": "Surf",
      "status": "success",
      "scope": "sui-premium",
      "message": "Collected source cards."
    }
  ],
  "finalAnswer": {},
  "usage": {},
  "proof": {
    "storage": {
      "status": "prepared",
      "evidenceUri": "langclaw://evidence/run-id/0x..."
    },
    "chain": {
      "status": "anchored",
      "chain": "sui-mainnet",
      "network": "mainnet",
      "decisionHash": "0x...",
      "decisionId": "1",
      "agentId": "133",
      "signalType": "smart-money",
      "txDigest": "..."
    },
    "compute": {
      "status": "used",
      "provider": "OpenAI",
      "requestedModel": "gpt-5.4-nano",
      "usedModel": "gpt-5.4-nano"
    }
  }
}
```

`signals` is schema-stable. `report` is additive and preferred for UI rendering.
Ranked entities and tables should appear only when the run includes real
entity-level or row-level metrics.

## Wallet Auth

### `POST /api/wallet/challenge`

Creates a nonce challenge for wallet login or API-key creation.

### `POST /api/wallet/session`

Verifies the signed wallet challenge and returns a short session token.

## API Keys

### `POST /api/api-keys`

Creates, lists, and revokes wallet-scoped API keys after a wallet challenge with
the correct purpose. API keys are HMAC-protected with `LANGCLAW_API_KEY_PEPPER`.

## Memory

### `POST /api/memory`

Lists, updates, and deletes wallet-scoped memory records.

### `POST /api/memory/settings`

Reads and updates wallet-scoped memory settings.

## Watchlist

### `POST /api/watchlist`

Lists, upserts, deletes, or clears Alpha Watchlist items for the authenticated
wallet. Watchlist items are saved Sui intelligence signals with title, summary,
source counts, source gaps, proof metadata, and follow-up context.

## Usage

### `POST /api/usage/balance`

Reads the prepaid selected-chain usage balance.

Request:

```json
{
  "chain": "sui-mainnet",
  "wallet": {
    "address": "0x...",
    "sessionToken": "..."
  }
}
```

### `POST /api/usage/quote`

Returns estimated model usage pricing in internal MIST-denominated ledger units.

Request:

```json
{
  "chain": "sui-mainnet"
}
```

### `POST /api/usage/vault`

Returns selected-chain vault metadata, billing currency metadata, vault address,
withdrawal authority, and configuration status.

### `POST /api/usage/deposit/verify`

Verifies a SUI deposit transaction against the selected chain's Usage Vault,
then credits the internal ledger.

Request:

```json
{
  "chain": "sui-mainnet",
  "txDigest": "...",
  "depositReference": "0x...",
  "wallet": {
    "address": "0x...",
    "sessionToken": "..."
  }
}
```

### `POST /api/usage/withdraw/request`

Returns withdrawal instructions and current withdrawable balance. On-chain
withdrawal still requires the user to send the vault transaction from their
wallet after the backend authorizes it.

## Automation

### `POST /api/automation/settings`

Reads or updates wallet-scoped automation settings, including notification
preferences.

### `POST /api/automation/tasks`

Creates, lists, updates, pauses, resumes, runs, or deletes scheduled monitoring
tasks.

### `POST /api/automation/runs`

Lists automation run history or runs a task immediately depending on action.

### `POST /api/automation/notifications`

Lists in-app notifications, marks notifications read, links email, links
Telegram, polls Telegram link status, and unlinks channels.

### `POST /api/automation/telegram/webhook`

Receives Telegram webhook updates.

### `POST /api/automation/webhooks/:slug`

Receives task-specific webhook callbacks.

## Proof

### `POST /api/proofs/readiness`

Checks whether the selected product chain can record and read Langclaw proof
records before a demo.

Request:

```json
{
  "chain": "sui-mainnet"
}
```

Response:

```json
{
  "chain": "sui-mainnet",
  "network": "mainnet",
  "status": "ready",
  "ready": true,
  "checks": [
    {
      "id": "registry-readable",
      "status": "pass",
      "summary": "LangclawRegistry is readable."
    }
  ]
}
```

CLI equivalent:

```bash
npm run check:sui-proof
```

### `POST /api/proofs/walrus-readiness`

Checks the Walrus private-memory layer. Default mode reports adapter status and
verifies the latest proof. Strict mainnet mode fails if Walrus, Seal, MemWal, or
the Sui memory registry still use local fallback or disabled mode.

Request:

```json
{
  "ownerAddress": "0x...",
  "strictMainnet": true
}
```

CLI equivalents:

```bash
npm run check:walrus-readiness
npm run check:walrus-readiness:mainnet
```

### `POST /api/proofs/decisions`

Returns latest `LangclawRegistry` decisions for Proof Center.

Request:

```json
{
  "chain": "sui-mainnet",
  "limit": 25
}
```

## Strategy Lab

### `POST /api/strategy/scan-pairs`

Ranks pairs for the requested product chain from the configured Dune historical
dataset and returns the best candidate plus a preview backtest.

Request:

```json
{
  "chain": "sui-mainnet",
  "limit": 12,
  "queryId": "1234567"
}
```

### `POST /api/strategy/backtest`

Runs the Liquidity Momentum Strategy against Dune historical rows. The Dune
result should include `timestamp`, `pair_address`, `price_usd`, `liquidity_usd`,
and `volume_usd`; optional columns include `tx_count` and
`net_whale_flow_usd`.

Request:

```json
{
  "chain": "sui-mainnet",
  "pairAddress": "0x365722f12ceb2063286a268b03c654df81b7c00f365722f12ceb2063286a268b",
  "queryId": "1234567"
}
```

Response includes strategy parameters, parsed market bars, trades, equity curve,
win rate, max drawdown, PnL, latest signal, Dune evidence metadata, and a
trading journal proof with status `anchored`, `prepared`, `pending`, or
`failed`.

### `POST /api/strategy/paper-trade`

Creates a deterministic paper order from the latest backtest signal and records
a `paper-opened` journal proof when the selected chain's trading journal is
configured.

### `POST /api/strategy/runs`

Lists recent `LangclawTradingJournal` records from the requested chain. If the
journal is not configured, the response is honest and returns configuration
status or a clear error.

## Environment Summary

Core:

```bash
OPENAI_API_KEY=
OPENAI_CHAT_MODEL=gpt-5-mini
OPENAI_AGENT_MODEL=gpt-5.2
SUI_CHAIN_ENABLED=true
SUI_INTEL_PROOF_ENABLED=true
SUI_CHAIN_RPC_URL=https://fullnode.mainnet.sui.io
SUI_CHAIN_EXPLORER_URL=https://suivision.xyz
SUI_AGENT_ID=133
SUI_LANGCLAW_REGISTRY_PACKAGE_ID=0x95cdf14e4b313ff45af3188d47c8a04ba392d985173910912166b0bf59d6c1e6
SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID=0x95cdf14e4b313ff45af3188d47c8a04ba392d985173910912166b0bf59d6c1e6
SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID=0x95cdf14e4b313ff45af3188d47c8a04ba392d985173910912166b0bf59d6c1e6
SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID=0x059669f0a3a8cce17be0e03096f2aad831d46ca5c3c7780c8da794b3531684da
SUI_AGENT_PRIVATE_KEY=
SUI_TRADING_JOURNAL_ENABLED=true
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Provider keys:

```bash
BRAVE_SEARCH_API_KEY=
TAVILY_API_KEY=
GITHUB_TOKEN=
SURF_ENABLED=false
SURF_API_KEY=
ELFA_ENABLED=false
ELFA_API_KEY=
DUNE_API_KEY=
DUNE_STRATEGY_QUERY_ID=
ALCHEMY_API_KEY=
ETHERSCAN_API_KEY=
GOPLUS_API_KEY=
GOPLUS_API_SECRET=
```

EVM provider env values remain supported only for explicit analysis, but Sui
(`sui-mainnet` / `sui-testnet`) is the product chain.

## Error Statuses

| Status | Meaning |
| --- | --- |
| `400` | Malformed request or missing required body field |
| `401` | Wallet/API authentication missing or expired |
| `402` | Insufficient prepaid usage balance |
| `403` | Telegram chat is not linked |
| `404` | Route not found |
| `500` | Backend, provider, or chain failure |
