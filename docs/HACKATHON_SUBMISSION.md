# Langclaw Walrus Track Submission

## One line

Langclaw gives AI agents private, portable memory by encrypting research with
Seal, storing it on Walrus, and anchoring its content hash on Sui mainnet.

## Problem

AI research agents lose context between runs. Centralized memory also asks users
to trust one database operator with private research. Langclaw makes memory
portable and independently verifiable while keeping its contents encrypted.

## Product flow

1. A user connects a Sui wallet and runs research.
2. Langclaw recalls relevant prior memory for that wallet.
3. The agent produces a new source-backed report.
4. Seal encrypts the report under an owner-only Move policy.
5. Walrus stores the ciphertext and returns a blob ID.
6. Sui records the content hash, blob reference, policy, owner, and recorder.
7. A later run retrieves, decrypts, and reuses the memory.

## Why Walrus is essential

Walrus is the shared persistence layer, not a backup export. Chat, discover, and
scheduled automation all call the same memory workflow. Agent handoff artifacts
also use Walrus. A later run reads those artifacts before new analysis begins.

## Live mainnet evidence

Live app: <https://langclaw-sui-walrus.vercel.app>

| Item | Value |
| --- | --- |
| Sui network | `mainnet` |
| Langclaw package | `0x7f3578ebe174b0343cd96391b2a1c75d5db4ad82c793650b3950bdb5634192e5` |
| Usage Vault | `0x816064d45dfe06194a973bce4b38a137365bbd6979c61b0d09435b7a443f3eff` |
| Recorder | `0x4b635af81752a2bcdaeb908bd522173ad1c86a859a9c56ee59d3089c35e0a622` |
| Agent ID | `133` |
| Seal KeyServer | `0x86b608dcb3fcb9c629cfe6d865681977d1decb219a2eb98eb6058b87377feaf3` |
| Seal registration tx | `5dbnWfCpMY1aWALrayaDkWAiBH5TSFYWdhERbxFfRxV1` |
| Seal URL update tx | `Db7F2zbCXogBqAEyZQGwybMYVLkDMwH5xpUfLrWfPj77` |
| Public Walrus blob | `dFpx2A6pTOfEL41vTsOmMPo6LTMZ9aWlHsR24FwnanA` |
| Memory anchor tx | `aK7QiQdnbEXKtrHSZ5qifWcbfcBbu7UsFHsDjDFfR1H` |
| Agent decision tx | `AtTXAV8bTRdUCEJjWuUQvhhdHzepksYKkkCMUqNKCEZ7` |
| Walrus Site object | `0x423a0cf7bfa109ed48ae6fae63eead7b7eae751b0885925b137bfd1d9e597d2b` |

## Technical scope

- Built-in staged AI workflow with provider trace and honest source gaps.
- Real `@mysten/seal` threshold encryption on mainnet.
- Self-hosted Open mode Seal key server with HTTPS and on-chain registration.
- Walrus mainnet storage and independent aggregator read-back.
- Move modules for memory registry, access policy, decision proof, journal, and
  native SUI usage billing.
- Sui wallet authentication and owner-scoped memory recall.
- MemWal adapter for semantic memory lookup.
- No live-funds trading.

## Public verification

Run this command without private keys:

```bash
cd backend
npm run verify:public-proof
```

It checks three Walrus blobs, the Seal service identity, and the Sui memory
transaction. For the private round-trip on a configured operator machine:

```bash
npm run proof:seal
npm run check:walrus-readiness
npm run check:eligibility
npm run verify:sui-contracts
```

## Evaluation focus

- Innovation: private agent memory with portable ciphertext and on-chain proof.
- Technical quality: one end-to-end runtime path, strict failure handling, unit
  tests, CI, and public proof commands.
- Walrus usage: encrypted memories and inter-agent handoffs are stored and read
  back across runs.
- UX: the Memory page exposes the blob, hash, Seal policy, and Sui transaction.
- Impact: users retain control of long-lived AI research context across devices.
