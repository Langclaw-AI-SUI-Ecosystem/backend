# Langclaw Sui Alpha Demo Script

Use this script for a 3 to 4 minute Sui AI Alpha demo video. Keep the narration
analysis-first and avoid live-trading claims.

## 0:00 to 0:20

Say:

```text
Langclaw is a Sui AI Alpha & Data agent. It tracks smart-money flow, detects liquidity anomalies, reads on-chain protocol momentum, and records source-backed agent decisions on Sui.
```

Show:

- Langclaw home or chat screen.
- Sui / AI Alpha / Evidence-backed positioning.
- Wallet connection.
- Submission summary or repo overview.

## 0:20 to 0:50

Say:

```text
I enter a Sui alpha prompt. Langclaw routes it through planner, source, trend, evidence, verifier, and final conclusion steps while preserving provider trace and source gaps.
```

Show:

- Suggested prompt: `Find smart-money accumulation on Sui`.
- Suggested prompt: `Detect liquidity anomalies on Sui DEX pairs`.
- Suggested prompt: `Rank Sui protocols by TVL and yield momentum`.
- Sui Intelligence / research mode.
- Wallet and Telegram linked state.

## 0:50 to 1:25

Say:

```text
The tool layer prioritizes Sui data: Surf smart-money research, Dune rows, DEX Screener Sui pairs, DeFiLlama protocol and yield data, and explorer-backed proof checks. Provider failures stay visible as source gaps instead of being hidden.
```

Show:

- Sui chain selected.
- Provider trace with status and scope.
- Tool results with source URLs or fetched records.
- Source gap messages if optional providers are disabled or unavailable.
- `signals.social`, `signals.onchain`, and `signals.combined` style output.

## 1:25 to 2:10

Say:

```text
The answer is analysis-only, not a trading execution claim. It gives the signal, evidence, confidence, false-positive checks, risk note, and recommended watch action.
```

Show:

- Final Sui Alpha brief.
- Signal, evidence, confidence, risk note, and recommended watch action.
- Structured report cards or tables when row-level data exists.
- Candidate wallet table or liquidity anomaly table.
- Data source diagnostics and checks unavailable.
- Add the strongest result to Alpha Watchlist.

## 2:10 to 2:35

Say:

```text
Strategy Lab is a supporting module. It uses Dune historical data to backtest a Sui Liquidity Momentum Strategy, then opens a paper trade proof without touching live funds.
```

Show:

- Strategy Lab at `/strategy`.
- Sui pair scan.
- Dune query ID field when needed.
- Run Backtest.
- Equity curve and trade table.
- Open Paper Trade.
- Proof status: `prepared`, `anchored`, or `failed`.
- Say clearly that this is not live arbitrage, live swapping, or market-making.

## 2:35 to 3:15

Say:

```text
For transparency, Langclaw builds an evidence bundle and records the agent decision hash through the LangclawRegistry Move module on Sui. The record includes the agent ID, run ID, signal type, evidence URI, recorder, and timestamp.
```

Show:

- Agent Decision Proof panel.
- Proof Center at `/proofs`.
- `decisionHash`.
- `agentId = 133`.
- Latest demo decision `#1`.
- Agent ID `133`.
- Sui proof tx from the current mainnet Proof Center record.
- `signalType = smart-money` or `liquidity-anomaly`.
- Strategy Proofs section for `LangclawTradingJournal`.
- Telegram settings as the alert channel for monitor updates.

Use the current Proof Center records from the configured Sui registry during the
live demo.

## 3:15 to 3:45

Say:

```text
Langclaw fits AI Alpha & Data first: Sui on-chain data is the core source, the output is explainable with confidence and limits, false positives are handled conservatively, and every strong agent decision can be verified on Sui.
```

Show:

- Public GitHub organization or repos.
- Demo URL.
- Sui package and object explorer pages.
- Local verification command output.

## Pre-Recording Checklist

```bash
cd backend
npm run check:sui-proof
npm run check:eligibility
```

```bash
cd frontend
pnpm typecheck
pnpm build
```

```bash
cd move
sui move build
sui move test
```
