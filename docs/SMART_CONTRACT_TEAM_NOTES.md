# Smart Contract Team Notes

Langclaw uses a Sui Move package for prepaid usage balance, agent decision proof,
and Strategy Lab proof. Non-Sui chains remain only as backend analysis research
targets.

## Module Scope

The Sui package publishes five modules. The package ID and the Usage Vault shared
object are listed under Live Sui Deployments.

| Module | Responsibility | Not Responsible For |
| --- | --- | --- |
| `usage_vault` | Accept SUI deposits, emit deposit events, hold vault funds in a shared object, and let a backend-authorized signer approve withdrawals | AI decision proof, trading execution, model-provider billing |
| `decision_registry` | Record agent decisions with `agentId`, `runId`, `decisionHash`, `evidenceUri`, `signalType`, recorder, and timestamp | Usage deposits, withdrawals, strategy PnL |
| `trading_journal` | Record Strategy Lab backtests and paper trades with strategy metadata, deterministic hashes, PnL bps, status, recorder, and timestamp | Live trading, swaps, custody, usage balance |
| `memory_registry` | Anchor agent memory references on-chain | Usage billing, decision proof, strategy PnL |
| `access_policy` | Enforce owner-only Seal key release | Plaintext storage, account sessions, usage billing |

OpenAI is the inference provider. User SUI deposits are app usage credits, not
OpenAI account funding.

## Mainnet Sui Deployments

Network: Sui mainnet. Explorer base: https://suivision.xyz

| Item | Value |
| --- | --- |
| Package ID (`decision_registry`, `trading_journal`, `usage_vault`, `memory_registry`) | `0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5` |
| Usage Vault shared object | `0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff` |
| AdminCap object | `0x21314b9534ca673cac1c79d6d1a63b9b0469d684504c974d3e8a5588873e8d09` |

Agent identity:

| Item | Value |
| --- | --- |
| Agent ID | `133` |
| Agent wallet / recorder (deployer) | `0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622` |

Deployment transactions:

| Tx | Digest |
| --- | --- |
| Package publish | `6kmuA94JsgM7uJ7MN32WEbWFMkF5rBuLUrUwFT4eTKED` |
| Vault setup | `ALvypw6EvadDXo4MCzgNEPgLJ8jES3rVLsWZHCnnqYVH` |

- Recorder wallet: https://suivision.xyz/account/0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622

## Required Environment

```bash
SUI_CHAIN_ENABLED=true
SUI_INTEL_PROOF_ENABLED=true
SUI_CHAIN_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_NETWORK=mainnet
SUI_CHAIN_EXPLORER_URL=https://suivision.xyz
SUI_DEPLOYER_PRIVATE_KEY=
SUI_AGENT_WALLET=
SUI_AGENT_PRIVATE_KEY=
SUI_AGENT_ONCHAIN_TX=
SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID=
SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID=
SUI_LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID=
SUI_LANGCLAW_REGISTRY_PACKAGE_ID=
SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID=
SUI_TRADING_JOURNAL_ENABLED=true
SUI_AGENT_ID=133
LANGCLAW_EVIDENCE_BASE_URI=langclaw://evidence
LANGCLAW_STRATEGY_EVIDENCE_BASE_URI=langclaw://strategy
```

## Usage Vault Flow

1. User deposits SUI into the `usage_vault` shared object through its deposit
   entry function with a deposit reference and amount.
2. Frontend waits for the transaction to finalize.
3. Backend verifies the deposit event through the Sui RPC.
4. Backend credits the internal Supabase usage ledger.
5. Research/chat usage is deducted from the internal balance.
6. The AdminCap holder can withdraw an operator payout to a named recipient.
7. Every withdrawal emits a `Withdrawn` event with the remaining balance.

## Registry Flow

1. Langclaw builds a canonical evidence bundle from source cards, tool results,
   agent trace, report, and final answer.
2. Backend computes `decisionHash` over the canonical bundle.
3. Backend prepares `evidenceUri` using `LANGCLAW_EVIDENCE_BASE_URI`.
4. If `SUI_INTEL_PROOF_ENABLED=true`, backend submits the
   `decision_registry` record-decision entry function.
5. Proof Center reads the recorded decision object and displays transaction
   metadata.

## Trading Journal Flow

1. Strategy Lab fetches Dune historical rows.
2. Backend runs the selected chain's Liquidity Momentum Strategy.
3. Backend computes deterministic strategy `decisionHash` and `resultHash`.
4. Backend prepares `evidenceUri` using `LANGCLAW_STRATEGY_EVIDENCE_BASE_URI`.
5. If `SUI_TRADING_JOURNAL_ENABLED=true`, backend submits the
   `trading_journal` record-strategy-run entry function.
6. If the journal is not configured, the API returns a `prepared` proof state.
7. If submission or receipt lookup fails, the API returns `failed` with an error
   message.

## Operational Commands

```bash
cd backend
npm run check:eligibility
npm run check:sui-proof
npm run verify:sui-contracts
```

```bash
cd move/langclaw_memory
sui move build
sui move test
```

## Separation Rules

- Vault is billing only.
- Registry is agent decision proof only.
- Trading journal is strategy backtest and paper-trade proof only.
- Neither registry nor journal executes trades.
- Neither usage vault nor usage ledger should be described as investment
  custody.
