# Langclaw Sui Alpha Submission

This document is the Sui-facing submission narrative. For live eligibility
checks and command runbooks, see [`SUI_ELIGIBILITY.md`](./SUI_ELIGIBILITY.md).

## Track

Langclaw targets Sui AI agent and Proof of Ship style evaluation with a Sui
wallet flow as the user distribution path. The product narrative is
**AI Alpha & Data**: Sui intelligence, explainable signals, watchlists,
strategy backtesting, and on-chain agent proof.

Langclaw is not a live-funds trading executor. It produces source-backed Sui
intelligence, watchlist recommendations, Dune-backed strategy backtests,
paper-trading orders, and verifiable on-chain proof.

## One-Liner

Langclaw is a Sui-first AI intelligence and strategy agent that analyzes
smart-money flow, liquidity anomalies, protocol momentum, and DEX pair history,
then records agent decisions and paper-trading outcomes on Sui through Move proof
modules in a single deployed package.

## Why It Fits

| Requirement | Langclaw coverage |
| --- | --- |
| Sui on-chain data as a core source | Sui network `mainnet`, DEX Screener Sui pairs, DeFiLlama Sui protocol/yield data, optional Dune, Alchemy, and explorer providers |
| AI analysis depth | Planner, source normalization, signal synthesis, final answer generation, false-positive checks, and risk notes |
| Technical completeness | Backend API, frontend app, Sui wallet flow, usage vault, proof registry, strategy journal, memory registry, and provider-gap reporting |
| Sustainability | Modular provider layer, Supabase persistence, API keys, usage billing, automation, and notification hooks |
| Insight value | Smart-money summaries, liquidity anomaly checks, protocol/yield ranking, Alpha Watchlist, and source-backed confidence notes |
| Strategy proof | Sui Liquidity Momentum Strategy with Dune historical rows, equity curve, trade table, win rate, drawdown, deterministic paper orders, and journal proof status |

## User Problem

Sui builders, analysts, and trading teams need a fast way to screen Sui
token and protocol signals before adding a watchlist item or sharing a call. The
current workflow often splits on-chain rows, social context, risk checks, and
proof records across separate tools. Langclaw turns that workflow into one
Sui-focused agent run with source evidence, confidence notes, and an on-chain
decision record.

## Product Flow

1. User connects a Sui wallet on Sui mainnet.
2. User links Telegram from automation notification settings.
3. User asks a Sui alpha question in chat or research mode.
4. Backend reserves internal usage balance for agent research.
5. Langclaw runs provider-backed Sui intelligence tools.
6. Backend returns `signals`, `report`, `alphaSignal`, `providerTrace`, final
   answer, usage receipt, and proof metadata.
7. User can save strong output to Alpha Watchlist.
8. Proof Center reads the Sui `decision_registry` and `trading_journal` module
   records.
9. Strategy Lab can scan pairs, run a Dune-backed backtest, and open a paper
   trade proof without live-funds execution.

## Current Sui Proof Layer

| Item | Value |
| --- | --- |
| Sui network | `mainnet` |
| Move package (`decision_registry`, `trading_journal`, `usage_vault`, `memory_registry`) | pending mainnet publish |
| Usage Vault shared object | pending mainnet publish |
| AdminCap object | pending mainnet publish |
| Agent owner / recorder | `0x3044601613b894da25db9a014ec20a7e38e146ef9b4b6efccdde42544351c323` |
| Langclaw agent ID | `133` |
| Package publish / upgrade tx | pending mainnet publish |
| Vault setup tx | pending mainnet publish |

Explorer links:

- Recorder wallet: <https://suivision.xyz/account/0x3044601613b894da25db9a014ec20a7e38e146ef9b4b6efccdde42544351c323>

## Submission Readiness

| Area | Status | Evidence |
| --- | --- | --- |
| Sui mainnet contracts | Pending mainnet publish | Registry, Trading Journal, Usage Vault, and Memory Registry publish from one Move package |
| AI agent identity | Code ready | Agent ID `133` and deployer/recorder wallet are configured |
| On-chain agent proof | Pending mainnet publish | Agent decisions record through the `decision_registry` module after package id config |
| Sui wallet support | Code ready, media capture pending | Sui mainnet wallet path and SUI usage credits exist in frontend |
| Talent/App campaign ops | Manual follow-up | Project page, campaign enrollment, and leaderboard evidence must be confirmed outside the repo |
| Reward claim | Manual follow-up | Project Leader must claim through the program fallback before the reward deadline |

## Safety Policy

- Langclaw does not execute live-funds trades.
- Strategy Lab records backtests and paper trades only.
- User wallet actions stay explicit.
- Agent private keys stay in backend environment variables.
- Usage deposits are app credits, not investment deposits or model-provider
  account funding.
- Final answers must keep false-positive checks, source gaps, and caveats
  visible.

## Signal Quality

Langclaw does not treat every large flow as alpha. It scores signal quality from
source depth, provider status, row-level evidence, proof state, and missing
checks.

| Confidence | Meaning | Example evidence |
| --- | --- | --- |
| High | Multiple sources agree and wallet evidence includes labels plus follow-up checks. | Wallet flow rows, label or behavior evidence, retention check, source URL, and second-source validation |
| Medium | Row-level on-chain data exists, but identity or follow-up evidence is incomplete. | DEX accumulation rows, CEX withdrawal rows, token amount, USD value, trade count, window, provider status |
| Low | Narrative context exists, but provider coverage is weak or fallback synthesis was used. | No row-level flow, partial social signal, unavailable provider, or missing labels |

## False Positive Handling

- DEX-only rows are large-flow watchlist entries, not confirmed smart-money
  wallets.
- Confirmed smart money requires wallet labels plus retention or sell-pressure
  checks.
- CEX deposits are possible sell-pressure signals, not accumulation candidates.
- External token activity remains low-confidence context when it is not native to
  the requested chain.
- Empty provider rows do not create fake tables.

## Strategy Lab

Strategy Lab adds a paper-trading proof path without live-funds risk.

1. User chooses a Sui pair or scans Sui pairs.
2. Backend fetches historical rows from Dune using `DUNE_STRATEGY_QUERY_ID` or a
   submitted query ID.
3. Sui Liquidity Momentum Strategy backtests price momentum, volume and
   liquidity strength, minimum liquidity, optional whale flow, stop loss, take
   profit, and max holding time.
4. UI renders equity curve, trades, win rate, max drawdown, PnL, latest signal,
   and evidence metadata.
5. User opens a paper trade from the latest signal.
6. Backend computes deterministic `decisionHash` and `resultHash`, then records
   the run in the `trading_journal` module when Sui journal env is configured.

## Demo Prompts

Use these prompts in Sui Intelligence mode:

```text
Find smart-money accumulation on Sui
```

Expected result: Sui smart-money summary, evidence quality, risk note, source
gaps, and decision proof state.

```text
Detect liquidity anomalies on Sui DEX pairs
```

Expected result: Sui DEX pair evidence, liquidity/risk signal, anomaly table
when row-level data exists, and no unrelated chain leakage.

```text
Rank Sui protocols by TVL and yield momentum
```

Expected result: DeFiLlama-backed protocol and yield context for a Sui
ecosystem dashboard narrative.

Use Strategy Lab at `/strategy`:

```text
Scan Sui pairs, select the best pair, run a Dune-backed backtest, and open a paper trade proof.
```

Expected result: strategy metrics, equity curve, trade log, latest AI signal,
Dune evidence details, and an anchored or prepared `trading_journal`
proof.

## What To Say In The Video

1. Langclaw is an AI Alpha & Data agent for Sui, with Strategy Lab for
   verifiable backtesting and paper trading.
2. It uses Sui on-chain and provider data as the evidence base.
3. It separates usable evidence from provider gaps instead of hiding missing
   sources.
4. It records each AI decision hash on Sui through the `decision_registry`
   module.
5. The latest registry record is the agent decision proof for agent `133`.
6. Strong signals can be saved to Alpha Watchlist, while Proof Center shows
   registry history and Strategy Proofs.

## Local Verification

```bash
npm run check:sui-proof
npm run check:eligibility
npm run typecheck
npm test
```

## Proof / Billing Environment

Product proof, billing, and journal anchoring read these Sui env vars:

```text
SUI_CHAIN_ENABLED
SUI_INTEL_PROOF_ENABLED
SUI_LANGCLAW_REGISTRY_PACKAGE_ID
SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID
SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID
SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID
SUI_AGENT_PRIVATE_KEY
SUI_AGENT_ID
SUI_CHAIN_RPC_URL
SUI_CHAIN_EXPLORER_URL
```

## Caveat

Langclaw does not sign, send, swap, buy, sell, or execute live-funds trades in
the current build. Strategy Lab is scoped to backtesting and paper trading.

Usage billing is ledger-based: user SUI deposits on Sui are credited after
vault deposit verification, then research requests reserve and settle usage
balance internally.
</content>
</invoke>
