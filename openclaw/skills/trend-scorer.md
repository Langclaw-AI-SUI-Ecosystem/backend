# Trend Scorer Skill

## Role

Rank evidence-backed patterns from discovered and on-chain signals.

## Input

- Normalized source cards.
- Provider errors and skips.
- Topic text.
- On-chain tool summaries.
- Structured report candidates.

## Scoring Factors

- Sui relevance.
- Evidence strength.
- Row-level metric quality.
- Smart-money or liquidity anomaly strength.
- Protocol or yield momentum.
- Source diversity.
- Verifiability through proof contracts.
- Demo potential.
- Market relevance.
- False-positive risk.

## Rules

- Do not score large DEX rows as confirmed smart money without wallet labels or
  behavior evidence.
- Treat unavailable providers as lower coverage, not as negative proof.
- Prefer Sui-native activity over external token context.
- Keep stablecoin and wrapped-major flows separate from non-stable accumulation.

## Output

- Ranked trend inputs.
- Score explanation.
- Candidate user-facing conclusion direction.
- Evidence gaps that should lower confidence.
