# Langclaw Walrus Demo Script

Target length: 3 to 4 minutes.

## Pre-recording setup

- Use a Sui wallet that is already linked to Telegram.
- Turn on Developer Mode for that account if the demo should avoid prepaid SUI
  credit friction. Developer Mode skips reservations and returns zero-cost
  receipts.
- On the backend operator machine, copy `backend/.env.mainnet.example` to
  `backend/.env`, fill the secret placeholders, then run:

```bash
cd backend
npm run check:walrus-readiness:mainnet
npm run verify:public-proof
```

The strict readiness command must show Walrus `http` mode, Seal SDK mode, MemWal
ready, Sui registry ready, and latest memory proof retrievable from the public
aggregator.

## 0:00 to 0:25

Say:

```text
Langclaw gives AI agents private memory. It encrypts research with Seal, stores the ciphertext on Walrus, and anchors the memory hash on Sui mainnet.
```

Show the home page, connect a Sui wallet, then open Research.

## 0:25 to 1:15, first run

Use this prompt:

```text
Analyze the main risks and growth signals for Sui liquid staking protocols. Save the evidence for later recall.
```

Show the staged research steps and final answer. Keep provider gaps visible.

Say:

```text
This result is now encrypted before storage. The plaintext never goes to Walrus.
```

Open the proof panel. Show:

- `sealMode = seal-sdk-configured`
- Walrus storage and retrieval status
- hash verification
- blob ID and aggregator link
- Sui transaction link

## 1:15 to 2:05, independent proof

Open the Walrus blob link and Sui transaction in separate tabs. Explain that the
public blob contains ciphertext. Then show the Memory page with the same blob,
content hash, owner policy, and transaction.

Run:

```bash
cd backend
npm run verify:public-proof
```

Say:

```text
This command uses no private key. It independently checks Walrus, the Seal service identity, and the Sui transaction.
```

## 2:05 to 3:00, second run

Use this follow-up prompt from the same wallet:

```text
Continue the liquid staking analysis. Compare the new evidence with the risks remembered from my previous run.
```

Show recalled memory IDs and reused handoff blob IDs.

Say:

```text
Langclaw fetched the prior encrypted blob from Walrus, passed the owner-only Seal policy, decrypted it, and used it as context for this new run.
```

## 3:00 to 3:35, architecture and close

Show the live package, KeyServer object, and Move modules.

Say:

```text
Walrus is the memory layer, Seal controls private recall, and Sui records the proof. Chat, discover, and automation all use this same path. Langclaw turns isolated AI runs into a portable, verifiable memory loop.
```

## Recording checklist

```bash
cd backend
npm run proof:seal
npm run check:walrus-readiness:mainnet
npm run check:eligibility
npm run verify:public-proof
npm test
npm run build

cd ../frontend
node --test tests/sui-wallet.test.mjs
pnpm lint
pnpm build

cd ../move/langclaw_memory
sui move test
```
