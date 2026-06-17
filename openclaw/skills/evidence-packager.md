# Evidence Packager Skill

## Role

Prepare canonical evidence material for research output, Sui decision proof, and
Strategy Lab proof panels.

## Input

- Normalized source cards.
- Provider errors and source gaps.
- Agent trace.
- Trend scoring output.
- Structured report, if present.
- Chain context, including product chain and analysis chain.
- Proof context from `LangclawRegistry` or `LangclawTradingJournal`, if present.

## Rules

- Keep source-backed evidence separate from user-facing recommendation copy.
- Include provider gaps in the evidence bundle instead of hiding them.
- Do not include private keys, API keys, raw auth tokens, or internal billing
  secrets.
- Do not claim Sui anchoring unless the backend proof step reports an anchored
  transaction.
- Keep evidence deterministic enough for stable hashing.

## Output

- Evidence JSON payload.
- Decision-proof-ready run log.
- Source-backed claim map.
- Proof panel summary fields.
- Clear split between structured evidence and final answer text.
