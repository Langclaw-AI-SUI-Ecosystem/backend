import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "dotenv";

const rootDir = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const envPath = join(rootDir, ".env");
const duneBaseUrl = "https://api.dune.com/api/v1";

for (const path of [join(rootDir, ".env.local"), envPath]) {
  if (existsSync(path)) {
    config({ path, override: false });
  }
}

const apiKey = process.env.DUNE_API_KEY?.trim();
const writeEnv = process.argv.includes("--write-env");

if (!apiKey) {
  throw new Error("Set DUNE_API_KEY before creating the strategy query.");
}

const createResponse = await duneFetch("/query", {
  method: "POST",
  body: JSON.stringify({
    name: "Langclaw Sui Liquidity Momentum Strategy Rows",
    description:
      "Hourly Sui DEX bars for Langclaw Strategy Lab backtesting and paper-trade proof.",
    is_private: false,
    query_sql: getStrategyQuerySql(),
  }),
});
const queryId =
  createResponse.query_id ??
  createResponse.queryId ??
  createResponse.id ??
  createResponse.query?.id;

if (!queryId) {
  throw new Error(`Dune did not return a query id: ${JSON.stringify(createResponse)}`);
}

console.log(`Created Dune strategy query: ${queryId}`);

const executeResponse = await duneFetch(`/query/${queryId}/execute`, {
  method: "POST",
  body: JSON.stringify({
    performance: "small",
  }),
});
const executionId = executeResponse.execution_id;

if (!executionId) {
  throw new Error(
    `Dune did not return an execution id: ${JSON.stringify(executeResponse)}`
  );
}

console.log(`Execution id: ${executionId}`);

let finalStatus = null;
for (let attempt = 0; attempt < 60; attempt += 1) {
  await delay(3000);
  const status = await duneFetch(`/execution/${executionId}/status`);
  console.log(`Dune state: ${status.state}`);

  if (status.state === "QUERY_STATE_COMPLETED") {
    finalStatus = status;
    break;
  }

  if (
    status.state === "QUERY_STATE_FAILED" ||
    status.state === "QUERY_STATE_CANCELLED"
  ) {
    throw new Error(`Dune execution failed: ${JSON.stringify(status)}`);
  }
}

if (!finalStatus) {
  throw new Error(`Dune execution did not complete: ${executionId}`);
}

const result = await duneFetch(`/execution/${executionId}/results?limit=5`);
const rows = result.result?.rows ?? [];

if (!rows.length) {
  throw new Error("Dune strategy query executed but returned no sample rows.");
}

const firstRow = rows[0];
const requiredColumns = [
  "timestamp",
  "pair_address",
  "price_usd",
  "liquidity_usd",
  "volume_usd",
];
const missingColumns = requiredColumns.filter((column) => !(column in firstRow));

if (missingColumns.length) {
  throw new Error(
    `Dune result is missing required columns: ${missingColumns.join(", ")}`
  );
}

console.log(
  JSON.stringify(
    {
      queryId: String(queryId),
      rowsPreviewed: rows.length,
      firstPairAddress: firstRow.pair_address,
      firstTimestamp: firstRow.timestamp,
      executionCostCredits: finalStatus.execution_cost_credits ?? null,
    },
    null,
    2
  )
);

if (writeEnv) {
  upsertEnvValues(envPath, {
    DUNE_STRATEGY_QUERY_ID: String(queryId),
  });
  console.log(`Updated ${envPath}`);
}

async function duneFetch(path, init = {}) {
  const response = await fetch(`${duneBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Dune-Api-Key": apiKey,
      ...init.headers,
    },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Dune ${path} failed ${response.status}: ${text}`);
  }

  return payload;
}

function upsertEnvValues(path, values) {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const newline = existing.includes("\r\n") ? "\r\n" : "\n";
  const lines = existing.length ? existing.split(/\r?\n/) : [];
  const seen = new Set();
  const nextLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);

    if (!match || !(match[1] in values)) {
      return line;
    }

    seen.add(match[1]);
    return `${match[1]}=${values[match[1]]}`;
  });

  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) {
      nextLines.push(`${key}=${value}`);
    }
  }

  writeFileSync(path, nextLines.join(newline).replace(/\s*$/, newline));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getStrategyQuerySql() {
  return `
WITH normalized_trades AS (
    SELECT
        date_trunc('hour', block_time) AS timestamp,
        lower(CAST(project_contract_address AS varchar)) AS pair_address,
        amount_usd,
        tx_hash,
        CASE
            WHEN token_sold_symbol IN ('USDC', 'USDT', 'USDe', 'mUSD', 'USDm', 'cUSD', 'cEUR', 'cREAL', 'USDT0')
                AND token_bought_amount > 0
                THEN amount_usd / token_bought_amount
            WHEN token_bought_symbol IN ('USDC', 'USDT', 'USDe', 'mUSD', 'USDm', 'cUSD', 'cEUR', 'cREAL', 'USDT0')
                AND token_sold_amount > 0
                THEN amount_usd / token_sold_amount
            WHEN token_bought_amount > 0
                THEN amount_usd / token_bought_amount
            WHEN token_sold_amount > 0
                THEN amount_usd / token_sold_amount
        END AS price_usd
    FROM dex_sui.trades
    WHERE blockchain = 'sui'
        AND block_time >= now() - interval '30' day
        AND amount_usd > 0
        AND project_contract_address IS NOT NULL
),
top_pairs AS (
    SELECT pair_address
    FROM normalized_trades
    WHERE price_usd > 0
    GROUP BY pair_address
    ORDER BY sum(amount_usd) DESC
    LIMIT 20
)
SELECT
    normalized_trades.timestamp,
    normalized_trades.pair_address,
    CAST(approx_percentile(normalized_trades.price_usd, 0.5) AS double) AS price_usd,
    CAST(greatest(sum(normalized_trades.amount_usd) * 8, 50000) AS double) AS liquidity_usd,
    CAST(sum(normalized_trades.amount_usd) AS double) AS volume_usd,
    CAST(count(DISTINCT normalized_trades.tx_hash) AS bigint) AS tx_count,
    CAST(0 AS double) AS net_whale_flow_usd
FROM normalized_trades
JOIN top_pairs ON normalized_trades.pair_address = top_pairs.pair_address
WHERE normalized_trades.price_usd > 0
GROUP BY 1, 2
HAVING sum(normalized_trades.amount_usd) > 0
ORDER BY normalized_trades.pair_address, normalized_trades.timestamp
LIMIT 5000
`;
}
