# Langclaw OpenClaw Workflow

Langclaw uses this folder as the local OpenClaw skill workspace for agent
reasoning. Provider calls remain in TypeScript so API keys stay server-side and
tool responses can be normalized before the agent sees them.

## Runtime Role

OpenClaw is the reasoning and orchestration layer. The backend owns:

- Wallet/API authentication and Telegram-link checks.
- Usage reservation and settlement.
- Provider calls to Surf, Brave, Elfa, GitHub, Tavily, HackQuest, Dune, DEX
  Screener, DeFiLlama, Alchemy, explorer APIs, CoinGecko, GeckoTerminal, and
  chain-specific tools.
- Proof preparation and Sui anchoring.

OpenClaw steps consume normalized context and return structured planning,
scoring, evidence, verification, and final-answer material.

## Skill Order

The public workflow calls `runLangclawWorkflow(topic)`. A research run routes the
topic through these conceptual steps:

1. Planner Skill
2. Discovery Skill
3. Source Normalizer Skill
4. Trend Scorer Skill
5. Evidence Packager Skill
6. Verifier Skill
7. Final Conclusion Skill

The TypeScript workflow may produce deterministic fallback output for any step
that is unavailable. Fallback output must keep provider gaps explicit and must
not invent source rows, wallet labels, or chain transactions.

## Default Environment

```bash
OPENCLAW_ENABLED=true
OPENCLAW_CLI_PATH=openclaw
OPENCLAW_WORKFLOW_ENABLED=true
OPENCLAW_AI_SYNTHESIS=true
OPENCLAW_STEP_TIMEOUT_SECONDS=60
OPENCLAW_MODEL=
OPENAI_API_KEY=
OPENAI_CHAT_MODEL=gpt-5-mini
OPENAI_AGENT_MODEL=gpt-5.2
```

The frontend currently sends the fixed chat model ID `gpt-5.4-nano`. The backend
honors a requested model when supplied, otherwise it falls back to
`OPENAI_CHAT_MODEL` for direct chat and `OPENAI_AGENT_MODEL` for agent
synthesis.

## Proof Behavior

Proof work runs after the reasoning steps:

- `src/lib/openai-direct-chat.ts` calls the OpenAI Responses API for direct chat.
- `src/lib/langclaw/openai-synthesis.ts` calls the OpenAI Responses API for
  final-answer synthesis when OpenClaw AI synthesis is not the final path.
- `src/lib/langclaw/proof.ts` prepares the canonical evidence bundle hash and
  anchors the agent decision through the selected chain's `LangclawRegistry`.
- `src/lib/strategy/journal.ts` anchors Strategy Lab records through
  `LangclawTradingJournal`.

If Sui proof env values are missing, the API returns `prepared`, `skipped`, or
`failed` proof states instead of claiming that a transaction happened.

## Sui Defaults

The default product chain is Sui mainnet (agent ID `133`). The mainnet package
exposes the `decision_registry`, `trading_journal`, `usage_vault`, and
`memory_registry` modules after publish:

```bash
SUI_CHAIN_ENABLED=true
SUI_INTEL_PROOF_ENABLED=true
SUI_CHAIN_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_CHAIN_EXPLORER_URL=https://suivision.xyz
SUI_LANGCLAW_REGISTRY_PACKAGE_ID=
SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID=
SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID=
SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID=
SUI_LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID=
SUI_AGENT_PRIVATE_KEY=
SUI_AGENT_ID=133
```

Mainnet artifacts:

- Package: pending mainnet publish
- Usage Vault object: pending mainnet publish
- AdminCap object: pending mainnet publish
- Deployer / agent / recorder wallet: [`0x3044601613b894da25db9a014ec20a7e38e146ef9b4b6efccdde42544351c323`](https://suivision.xyz/account/0x3044601613b894da25db9a014ec20a7e38e146ef9b4b6efccdde42544351c323)

Non-Sui chains remain supported only as optional analysis research targets in the
on-chain tools layer, not as the product, billing, or proof chain. Sui product
surfaces run Surf and Dune first for smart-money research and expose unsupported
providers as source gaps.

## Operational Checks

From `backend/`:

```bash
npm run check:sui-proof
npm run check:eligibility
npm run typecheck
npm test
```
