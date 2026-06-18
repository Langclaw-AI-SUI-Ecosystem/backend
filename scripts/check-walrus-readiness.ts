// Walrus readiness check: reports adapter modes and verifies the latest
// encrypted memory proof can be retrieved from Walrus.
//
// Run: node --import tsx scripts/check-walrus-readiness.ts
// Strict mainnet: node --import tsx scripts/check-walrus-readiness.ts --strict-mainnet
import "../src/env";

import { getWalrusReadiness } from "../src/lib/readiness";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const ownerAddress =
    args.ownerAddress || process.env.READINESS_OWNER_ADDRESS?.trim() || undefined;
  const strictMainnet =
    args.strictMainnet ||
    ["1", "true", "yes", "on"].includes(
      (process.env.WALRUS_READINESS_STRICT_MAINNET || "").trim().toLowerCase()
    );
  const report = await getWalrusReadiness(ownerAddress, { strictMainnet });

  console.log(
    `Langclaw Sui Walrus - readiness${strictMainnet ? " (strict mainnet)" : ""}\n`
  );
  for (const check of report.checks) {
    const mark =
      check.status === "ready" || check.status === "local"
        ? "✔"
        : check.status === "disabled"
          ? "•"
          : "✖";
    console.log(`${mark} ${check.name.padEnd(20)} [${check.status}] ${check.message}`);
  }

  console.log("");
  console.log(`ready: ${report.ready}`);
  if (report.reason) {
    console.log(`reason: ${report.reason}`);
  }
  if (report.latest) {
    console.log(`latest blob: ${report.latest.walrusBlobId}`);
  }
  if (report.missing.length) {
    console.log(`missing: ${[...new Set(report.missing)].join(", ")}`);
  }

  process.exit(report.ready ? 0 : 1);
}

function parseArgs(args: string[]) {
  let strictMainnet = false;
  let ownerAddress: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--strict-mainnet" || arg === "--mainnet") {
      strictMainnet = true;
      continue;
    }

    if (arg === "--owner" || arg === "--owner-address") {
      ownerAddress = args[index + 1]?.trim() || undefined;
      index += 1;
      continue;
    }

    if (arg.startsWith("--owner=") || arg.startsWith("--owner-address=")) {
      ownerAddress = arg.slice(arg.indexOf("=") + 1).trim() || undefined;
    }
  }

  return { ownerAddress, strictMainnet };
}

main().catch((error) => {
  console.error("READINESS CHECK FAILED:", error);
  process.exit(1);
});
