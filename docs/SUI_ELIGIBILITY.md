# Sui Deployment & On-Chain Verification

This document records the Sui mainnet deployment target for Sui Alpha and
gives a repeatable command path for rechecking on-chain proof status. It is
strictly factual to the current mainnet configuration.

The product, billing, and proof surface targets Sui. Non-Sui chains are only
backend analysis targets, not product, billing, or proof chains.

## Core Criteria

1. Deploy the product Move package on Sui mainnet.
2. Keep the published package and shared objects discoverable in a public
   explorer.
3. Keep the public GitHub repositories open source and aligned with the current
   product state.
4. Keep the Sui AI agent recorder wallet funded and active on-chain.
5. Keep the usage vault shared object initialized and reachable for billing.
6. Treat Proof of Ship artifacts as score boosters, not base blockers.

## Current Sui Artifacts

| Item | Value |
| --- | --- |
| Sui network | `mainnet` |
| Package ID (`decision_registry`, `trading_journal`, `usage_vault`, `memory_registry`) | `0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5` |
| Usage Vault shared object | `0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff` |
| AdminCap object | `0x21314b9534ca673cac1c79d6d1a63b9b0469d684504c974d3e8a5588873e8d09` |
| Deployer / agent / recorder wallet | `0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622` |
| Publish tx digest | `6kmuA94JsgM7uJ7MN32WEbWFMkF5rBuLUrUwFT4eTKED` |
| Vault setup tx digest | `ALvypw6EvadDXo4MCzgNEPgLJ8jES3rVLsWZHCnnqYVH` |
| Agent ID | `133` |

Mainnet RPC is configured. Package publication and usage vault initialization are
pending a funded mainnet deployer wallet.

## Current Verification Status

- The Move package (`decision_registry`, `trading_journal`, `usage_vault`,
  `memory_registry`) must be published on Sui mainnet before proof or billing
  can execute on-chain.
- The SUI-backed usage vault becomes live after the mainnet publish creates the
  shared vault object.
- The AdminCap object id must come from the mainnet publish output and authorizes
  vault administration.
- The agent / recorder wallet
  `0x3044601613b894da25db9a014ec20a7e38e146ef9b4b6efccdde42544351c323` records
  decisions on-chain under agent ID `133`.

## Eligibility Notes

- The recorder wallet must be funded on Sui mainnet before publish, proof, or
  journal transactions can execute.
- Public GitHub proof is evaluated from the actual GitHub organization and
  repositories. Recheck `.github`, `backend`, `contracts`, and `frontend`
  origins before submitting.

## Commands

Audit current status from local env plus live chain and explorer data:

```bash
cd backend
npm run check:eligibility
```

Check proof-readiness for the configured Sui registry:

```bash
cd backend
npm run check:sui-proof
```

## Sui Proof Environment

The proof/billing/journal integration needs the following values in the current
process environment or `backend/.env`:

```bash
SUI_CHAIN_ENABLED=true
SUI_INTEL_PROOF_ENABLED=true
SUI_LANGCLAW_REGISTRY_PACKAGE_ID=
SUI_LANGCLAW_TRADING_JOURNAL_PACKAGE_ID=
SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID=
SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID=
SUI_LANGCLAW_USAGE_VAULT_ADMIN_CAP_OBJECT_ID=
SUI_AGENT_PRIVATE_KEY=
SUI_AGENT_ID=133
SUI_CHAIN_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_NETWORK=mainnet
SUI_CHAIN_EXPLORER_URL=https://suivision.xyz
```

The recorder wallet uses `SUI_AGENT_PRIVATE_KEY` to sign on-chain decision and
journal transactions.

## Explorer Targets

- Deployer / recorder wallet:
  [SuiVision](https://suivision.xyz/account/0x3044601613b894da25db9a014ec20a7e38e146ef9b4b6efccdde42544351c323)

## Monthly Evidence Pack

Keep these artifacts before each claim or review window:

- Public repository links for frontend, backend, contracts, and profile.
- SuiVision package link for the published Move package.
- SuiVision object link for the usage vault shared object.
- Package upgrade transaction digest.
- Usage vault setup transaction digest.
- SUI usage-credit flow screenshot or recording.
- Proof Center screenshot showing agent decisions and strategy proofs.
