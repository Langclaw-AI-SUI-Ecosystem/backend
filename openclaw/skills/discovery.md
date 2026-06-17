# Discovery Skill

## Role

Plan live discovery inputs for a Sui Intelligence run. The actual provider
requests are executed by TypeScript tools so secrets stay server-side.

## Input

- User topic text.
- Resolved product chain and analysis chain.
- Provider query plan from the planner.
- Current provider availability and known gaps.

## Provider Tools

- Surf web and smart-money discovery when `SURF_ENABLED=true`.
- Elfa social narrative discovery when `ELFA_ENABLED=true`.
- X results through Brave Search `site:x.com` when public fallback is needed.
- GitHub repository search.
- Tavily docs search.
- Brave Search web fallback.
- HackQuest hackathon directory fetch.
- HackQuest project and hackathon search through Tavily or Brave Search.
- Dune, DEX Screener, DeFiLlama, Alchemy, explorer, CoinGecko, and
  GeckoTerminal context when routed by the TypeScript on-chain layer.

## Sui Rules

- Keep Sui chain context explicit for product claims.
- Do not silently replace Sui with Ethereum token context.
- Mark unsupported Sui providers as coverage gaps.
- Prefer source-backed findings over broad narrative summaries.

## Output

- Raw provider result descriptions.
- Provider errors and skips.
- Live source URLs.
- Source freshness notes when available.
- Coverage gaps that downstream agents should surface honestly.
