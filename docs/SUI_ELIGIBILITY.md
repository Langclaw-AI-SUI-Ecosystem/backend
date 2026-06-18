# Sui Mainnet Verification

This file records current, public Sui artifacts for Langclaw.

## Current artifacts

| Item | Value |
| --- | --- |
| Network | `mainnet` |
| Package | `0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5` |
| Usage Vault | `0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff` |
| AdminCap | `0x21314b9534ca673cac1c79d6d1a63b9b0469d684504c974d3e8a5588873e8d09` |
| Recorder | `0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622` |
| Agent ID | `133` |
| Package publish tx | `6kmuA94JsgM7uJ7MN32WEbWFMkF5rBuLUrUwFT4eTKED` |
| Vault setup tx | `ALvypw6EvadDXo4MCzgNEPgLJ8jES3rVLsWZHCnnqYVH` |
| Memory anchor tx | `aK7QiQdnbEXKtrHSZ5qifWcbfcBbu7UsFHsDjDFfR1H` |
| Agent decision tx | `AtTXAV8bTRdUCEJjWuUQvhhdHzepksYKkkCMUqNKCEZ7` |
| Seal KeyServer | `0x86b608dcb3fcb9c629cfe6d865681977d1decb219a2eb98eb6058b87377feaf3` |
| KeyServer registration tx | `5dbnWfCpMY1aWALrayaDkWAiBH5TSFYWdhERbxFfRxV1` |
| KeyServer URL update tx | `Db7F2zbCXogBqAEyZQGwybMYVLkDMwH5xpUfLrWfPj77` |

The package, shared vault, recorder, memory anchor, and Seal KeyServer are live.
The backend uses mainnet RPC and strict Seal mode. A Seal failure stops private
memory storage instead of falling back to a local envelope.

## Commands

```bash
cd backend
npm run check:eligibility
npm run check:walrus-readiness
npm run proof:seal
npm run verify:public-proof
npm run verify:sui-contracts
```

## Required environment

```text
SUI_CHAIN_ENABLED=true
SUI_INTEL_PROOF_ENABLED=true
SUI_NETWORK=mainnet
SUI_CHAIN_RPC_URL=https://fullnode.mainnet.sui.io:443
SUI_CHAIN_EXPLORER_URL=https://suivision.xyz
SUI_LANGCLAW_REGISTRY_PACKAGE_ID=0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5
SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID=0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff
SUI_AGENT_ID=133
SEAL_MOCK_MODE=false
SEAL_STRICT_MODE=true
SEAL_KEY_SERVER_OBJECT_IDS=0x86b608dcb3fcb9c629cfe6d865681977d1decb219a2eb98eb6058b87377feaf3
```

Keep `SUI_AGENT_PRIVATE_KEY` and the Seal master key outside source control.

## Explorer links

- [Package](https://suivision.xyz/object/0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5)
- [Usage Vault](https://suivision.xyz/object/0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff)
- [Recorder](https://suivision.xyz/account/0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622)
- [Memory anchor](https://suivision.xyz/txblock/aK7QiQdnbEXKtrHSZ5qifWcbfcBbu7UsFHsDjDFfR1H)
- [Agent decision](https://suivision.xyz/txblock/AtTXAV8bTRdUCEJjWuUQvhhdHzepksYKkkCMUqNKCEZ7)
- [Seal KeyServer](https://suivision.xyz/object/0x86b608dcb3fcb9c629cfe6d865681977d1decb219a2eb98eb6058b87377feaf3)
