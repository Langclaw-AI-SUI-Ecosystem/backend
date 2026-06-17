// Walrus readiness check: reports adapter modes and verifies the latest
// encrypted memory proof can be retrieved from Walrus.
//
// Run: node --import tsx scripts/check-walrus-readiness.ts
import "../src/env";

import { getWalrusReadiness } from "../src/lib/readiness";

async function main() {
  const ownerAddress = process.env.READINESS_OWNER_ADDRESS?.trim() || undefined;
  const report = await getWalrusReadiness(ownerAddress);

  console.log("Langclaw Sui Walrus — readiness\n");
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

  process.exit(report.ready ? 0 : 1);
}

main().catch((error) => {
  console.error("READINESS CHECK FAILED:", error);
  process.exit(1);
});
