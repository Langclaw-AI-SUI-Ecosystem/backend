# Langclaw Sui Alpha Blueprint

Langclaw is positioned for Sui as **Sui Alpha**: an AI agent that
turns Sui on-chain, market, and provider evidence into explainable alpha briefs,
watchlist actions, and verifiable on-chain proof records.

The product, billing, and proof surface targets Sui mainnet.

## One Sentence

Langclaw is a Sui-first AI intelligence agent that monitors smart-money flow,
liquidity anomalies, protocol momentum, and strategy backtests, then records
evidence-backed decisions on Sui through the `decision_registry` and
`trading_journal` Move modules.

## Track Fit

Primary narrative: **AI Alpha & Data / Sui AI agent proof**.

Why this fits:

- Sui mainnet is the product chain and default evidence scope.
- Output is an explainable AI alpha brief with confidence, caveats, and source
  gaps, not an autonomous trade claim.
- Sui proof modules are used for decision and strategy records after mainnet
  package ids are configured.
- SUI usage credits back research runs through the frontend wallet path.
- Sui Agent ID `133` connects the agent identity to on-chain evidence.

Live-funds trading is intentionally out of scope. Strategy Lab is limited to
backtesting and paper-trade proof records.

## Product Positioning

Frame Langclaw as:

```text
Sui Alpha: an AI agent for verifiable Sui alpha, smart-money monitoring, liquidity anomaly detection, and strategy proof.
```

Do not frame it as:

```text
An autonomous trading bot, market maker, arbitrage executor, or custody product.
```

The user asks a Sui alpha question. Langclaw runs provider-backed tools,
normalizes evidence, generates a risk-aware answer, saves strong signals to a
watchlist when requested, and prepares or records an on-chain proof.

## Core Demo Prompts

- `Find smart-money accumulation on Sui`
- `Detect liquidity anomalies on Sui DEX pairs`
- `Rank Sui protocols by TVL and yield momentum`
- `Analyze holder flow and smart-money signals on Sui token 0x2::sui::SUI`

## Agent Workflow

```text
User prompt
  -> Sui chain resolver
  -> Planner
  -> Discovery providers
     -> Surf / Brave / Elfa / GitHub / Tavily / HackQuest when configured
  -> On-chain tools
     -> Surf smart-money research
     -> Dune generated SQL or configured strategy query
     -> DEX Screener Sui pairs
     -> DeFiLlama Sui TVL / yield data
     -> Alchemy / explorer reads when configured
     -> GoPlus skipped honestly on Sui when unsupported
  -> Signal synthesis
  -> Structured report and alpha quality scoring
  -> Evidence packager
  -> Verifier
  -> Final Sui Alpha brief
  -> Optional decision_registry decision proof on Sui
  -> Optional trading_journal strategy proof on Sui
```

## Output Shape

Each Sui Intelligence run should surface:

- Signal type, such as `smart-money`, `liquidity-anomaly`, `defi-yield`, or
  `mixed-research`.
- Executive summary and bottom line.
- Evidence cards, tool results, and provider trace.
- Ranked entities or tables only when row-level metrics exist.
- Confidence label and quality score.
- False-positive checks and source gaps.
- Risk note and recommended watch action.
- Usage receipt when the request is billed.
- Evidence URI, decision hash, agent ID, and Sui transaction link when proof
  anchoring is configured.

## Proof Modules

The mainnet package exposes the `decision_registry`, `trading_journal`,
`usage_vault`, and `memory_registry` Move modules after publish.

The `decision_registry` module records agent decisions:

```move
public struct AgentDecision has store {
    agent_id: u64,
    run_id: String,
    decision_hash: vector<u8>,
    evidence_uri: String,
    signal_type: String,
    recorder: address,
    created_at: u64,
}
```

The `trading_journal` module records Strategy Lab runs:

```move
public struct StrategyRecord has store {
    agent_id: u64,
    run_id: String,
    strategy_id: String,
    market: String,
    decision_hash: vector<u8>,
    result_hash: vector<u8>,
    evidence_uri: String,
    action: String,
    pnl_bps: i64,
    status: String,
    recorder: address,
    created_at: u64,
}
```

The `usage_vault` module accepts SUI deposits, emits deposit events, and lets the
backend-authorized withdrawal authority approve withdrawals via the `AdminCap`.
Set `SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID`,
`SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID`, and
`SUI_LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID` from the mainnet publish output.

## UI Scope

Keep the product surface focused on the working app:

- Chat and Sui Intelligence mode.
- Wallet + Telegram gate for research runs.
- Alpha Watchlist for saved signals.
- Usage page for SUI credits and vault interactions.
- Strategy Lab for scan, backtest, equity curve, trades, and paper proof.
- Proof Center for registry decisions and strategy journal records.
- Sui mainnet wallet path.

## Scoring Narrative

- **Data source quality:** Sui chain, Surf, Dune, DEX Screener, DeFiLlama,
  explorer reads, and provider trace metadata.
- **AI analysis depth:** signal synthesis, confidence, false-positive checks,
  risk notes, source gaps, and recommended next actions.
- **Technical completeness:** backend workflow, frontend app, wallet auth,
  usage billing, automation, proof contracts, and eligibility scripts.
- **Insight value:** smart-money tracking, liquidity anomaly detection,
  protocol/yield ranking, watchlist, and strategy backtesting.
- **Verifiability:** every anchored decision has a hash, evidence URI, agent ID,
  recorder, timestamp, and Sui transaction.

## MVP Acceptance

- Sui is the default product chain; the Sui network resolves to `mainnet`.
- Sui Intelligence returns signal, evidence, confidence, caveats, risk, and
  action guidance.
- Provider failures are visible as source gaps.
- Research requests reserve and settle usage balance when billing is enabled.
- `decision_registry` returns recorded agent decisions for Proof Center.
- `trading_journal` returns strategy records when configured.
- Frontend loads with Sui-first wallet config and Sui mainnet UX.
- Docs explain analysis-first scope without claiming live trade execution.
