// Dry-run the usage_vault::deposit PTB against the configured Sui network.
// This proves the exact
// transaction the frontend builds (split a SUI coin off gas -> moveCall deposit
// with [vault, coin, empty u8 vector]) is valid against the live Move module,
// WITHOUT spending anything (dryRunTransactionBlock does not execute).
//
//   cd backend && node --import tsx scripts/usage-deposit-dryrun.ts
//
// Exits non-zero if the dry run does not succeed or no Deposited event would fire.

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const RPC = process.env.SUI_RPC_URL?.trim() || "https://fullnode.mainnet.sui.io:443";
const NETWORK = process.env.SUI_NETWORK?.trim() || "mainnet";
const PKG = requireEnv("SUI_LANGCLAW_USAGE_VAULT_PACKAGE_ID");
const VAULT = requireEnv("SUI_LANGCLAW_USAGE_VAULT_OBJECT_ID");
// A funded address used only as the dry-run sender (no signature/spend).
const SENDER =
  process.env.SUI_DRYRUN_SENDER?.trim() ||
  "0x3044601613b894da25db9a014ec20a7e38e146ef9b4b6efccdde42544351c323";

const DEPOSIT_TARGET = `${PKG}::usage_vault::deposit`;
const AMOUNT_MIST = BigInt(10_000_000); // 0.01 SUI

async function main() {
  const client = new SuiJsonRpcClient({ url: RPC, network: NETWORK as "mainnet" });

  const tx = new Transaction();
  tx.setSender(SENDER);
  const [coin] = tx.splitCoins(tx.gas, [AMOUNT_MIST]);
  tx.moveCall({
    target: DEPOSIT_TARGET,
    arguments: [tx.object(VAULT), coin, tx.pure.vector("u8", [])],
  });

  const bytes = await tx.build({ client });
  const res = await client.dryRunTransactionBlock({ transactionBlock: bytes });

  const status = res.effects.status.status;
  const events = (res.events ?? []).map((event) => event.type);
  const depositedEvent = events.find((type) => type.endsWith("::usage_vault::Deposited"));

  console.log("target          :", DEPOSIT_TARGET);
  console.log("vault object    :", VAULT);
  console.log("DRY-RUN status  :", status);
  console.log("error           :", res.effects.status.error ?? "none");
  console.log("events emitted  :", events.join(", ") || "(none)");
  console.log(
    "balanceChanges  :",
    (res.balanceChanges ?? [])
      .map((change) => `${change.amount} ${change.coinType}`)
      .join(" | ") || "(none)",
  );

  if (status !== "success") {
    throw new Error(`Dry run failed: ${res.effects.status.error ?? status}`);
  }
  if (!depositedEvent) {
    throw new Error("Dry run succeeded but no Deposited event would be emitted.");
  }

  console.log(
    `\nOK deposit PTB is valid against the live module and would emit ${depositedEvent}.`,
  );
}

function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required. Publish the usage_vault package on mainnet first.`);
  }
  return value;
}

main().catch((error) => {
  console.error("\nFAIL deposit dry-run:", error instanceof Error ? error.message : error);
  process.exit(1);
});
