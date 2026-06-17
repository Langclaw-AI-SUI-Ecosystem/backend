import "../env";

import { buildProofReadinessReport } from "../lib/proof-readiness";

void main();

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildProofReadinessReport({ chain: options.chain });

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  process.exitCode = report.ready ? 0 : 1;
}

function parseArgs(args: string[]) {
  let chain = "sui-mainnet";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--chain") {
      chain = args[index + 1] || chain;
      index += 1;
      continue;
    }

    if (arg.startsWith("--chain=")) {
      chain = arg.slice("--chain=".length);
    }
  }

  return { chain, json };
}

function printReport(report: Awaited<ReturnType<typeof buildProofReadinessReport>>) {
  console.log(`Proof readiness: ${report.status}`);
  console.log(`Chain: ${report.chainName} (${report.chainId})`);
  console.log(`RPC: ${report.rpcUrl}`);

  if (report.registryAddress) {
    console.log(`Registry: ${report.registryAddress}`);
  }

  if (report.recorder) {
    console.log(`Recorder: ${report.recorder.address}`);
    console.log(`Balance: ${report.recorder.balance}`);
  }

  if (report.latestDecision) {
    console.log(
      `Latest decision: #${report.latestDecision.decisionId} ${report.latestDecision.signalType}`
    );
  }

  console.log("");

  for (const check of report.checks) {
    console.log(`[${check.status.toUpperCase()}] ${check.label}: ${check.summary}`);
  }
}
