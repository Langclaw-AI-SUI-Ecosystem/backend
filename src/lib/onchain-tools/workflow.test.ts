import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runOnChainToolWorkflow } from "./workflow";
import { jsonResponse, mockFetch, withEnv } from "../../test/helpers";

async function runSmartMoneyWorkflowWithMock(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  message = "Find smart-money accumulation on Mantle"
) {
  const restore = mockFetch(handler);

  try {
    return await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_DEFAULT_QUERY_ID: "123456",
        NANSEN_API_KEY: "nansen-test-key",
        NANSEN_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message,
        })
    );
  } finally {
    restore();
  }
}

function mockCompletedDuneSqlRows(
  parsed: URL,
  init: RequestInit | undefined,
  rows: Record<string, unknown>[]
) {
  if (
    parsed.hostname === "api.dune.com" &&
    parsed.pathname === "/api/v1/sql/execute"
  ) {
    assert.equal(init?.method, "POST");

    return jsonResponse({
      execution_id: "01KSMARTMONEY",
      state: "QUERY_STATE_PENDING",
    });
  }

  if (
    parsed.hostname === "api.dune.com" &&
    parsed.pathname === "/api/v1/execution/01KSMARTMONEY/status"
  ) {
    return jsonResponse({
      execution_id: "01KSMARTMONEY",
      is_execution_finished: true,
      state: "QUERY_STATE_COMPLETED",
    });
  }

  if (
    parsed.hostname === "api.dune.com" &&
    parsed.pathname === "/api/v1/execution/01KSMARTMONEY/results"
  ) {
    return jsonResponse({
      result: {
        rows,
      },
    });
  }

  return undefined;
}

function createMockSurfCli(rows: Record<string, unknown>[]) {
  const directory = mkdtempSync(join(tmpdir(), "surf-cli-"));
  const callsPath = join(directory, "calls.jsonl");
  const cliPath = join(directory, "surf");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
fs.appendFileSync(process.env.SURF_CLI_TEST_CALLS, JSON.stringify({ args, stdin }) + "\\n");
if (!args.includes("onchain-sql")) {
  console.error("unexpected command");
  process.exit(2);
}
const payload = JSON.parse(stdin || "{}");
if (!String(payload.sql || "").includes("agent.arbitrum_dex_trades")) {
  console.error("unexpected sql");
  process.exit(3);
}
console.log(JSON.stringify({
  data: ${JSON.stringify(rows)},
  meta: { cached: false, credits_used: 1 }
}));
`;

  writeFileSync(cliPath, script, "utf8");
  chmodSync(cliPath, 0o755);

  return {
    callsPath,
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    path: cliPath,
  };
}

test("Nansen smart-money netflow request omits unsupported fields", async () => {
  const result = await runSmartMoneyWorkflowWithMock((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      assert.equal(init?.method, "POST");

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        filters?: Record<string, unknown>;
        query?: unknown;
      };

      assert.equal("query" in body, false);
      assert.equal("value_usd" in (body.filters ?? {}), false);
      assert.deepEqual(body.filters?.include_smart_money_labels, [
        "Fund",
        "Smart Trader",
      ]);

      return jsonResponse({
        data: [
          {
            net_flow_7d_usd: 180000,
            symbol: "MNT",
          },
        ],
      });
    }

    return jsonResponse({ ok: true });
  }, "Find smart-money accumulation on Mantle empty nansen query 123456");

  const smartMoney = result.payload.tools.find(
    (tool) => tool.commandId === "smart_money.smart_money_dune"
  );

  assert.equal(smartMoney?.provider, "nansen");
  assert.equal(smartMoney?.status, "success");
  assert.ok(
    result.payload.providerTrace?.some(
      (entry) => entry.provider === "nansen" && entry.status === "success"
    )
  );
});

test("Surf ability smart-money research is used before Dune fallback", async () => {
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      assert.equal(init?.method, "POST");

      const body = JSON.parse(String(init?.body ?? "{}")) as {
        ability?: string[];
        messages?: Array<{ content?: string; role?: string }>;
        model?: string;
      };

      assert.deepEqual(body.ability, [
        "evm_onchain",
        "market_analysis",
        "search",
        "calculate",
      ]);
      assert.equal(body.model, "surf-1.5");
      assert.ok(
        body.messages?.some((message) =>
          message.content?.includes("Analysis chain: mantle")
        )
      );

      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bottomLine:
                  "Watch repeat CEX withdrawals and DEX buys above $100K per wallet.",
                rows: [
	                  {
	                    confidence: "Medium",
	                    netToken: "177.7K",
	                    netUsd: "$120.9K",
	                    signal: "CEX withdrawal",
	                    sourceCex: "Bybit",
	                    tokenSymbol: "PUFF",
	                    transfers: 3,
	                    wallet: "0xbdb3...47b6",
                    window: "2026-05-21",
                  },
                ],
                sections: [
                  {
                    markdown:
                      "The clearest signal is candidate accumulation, not confirmed fund flow.",
                    title: "Read",
                  },
                  {
                    markdown: "Surf returned row-level CEX withdrawal evidence.",
                    title: "Evidence",
                  },
                  {
                    markdown: "Best candidate: 0xbdb3...47b6.",
                    title: "Candidates",
                  },
                  {
                    markdown: "Wallet labels remain incomplete.",
                    title: "Limits",
                  },
                  {
                    markdown: "Monitor repeat withdrawals.",
                    title: "Conclusion",
                  },
                ],
                summary:
                  "Surf ability found candidate Mantle smart-money accumulation rows.",
              }),
            },
          },
        ],
        id: "surf-chat-test",
        model: "surf-1.5",
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        DUNE_API_KEY: "",
        SURF_API_KEY: "surf-test-key",
        SURF_CHAT_MODEL: "surf-1.5",
        SURF_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: "Find smart-money accumulation on Mantle last 9 days",
        })
    );
    const smartMoney = result.payload.tools.find(
      (tool) => tool.commandId === "smart_money.surf_smart_money_research"
    );

    assert.equal(smartMoney?.provider, "surf");
    assert.equal(smartMoney?.status, "success");
    assert.deepEqual(smartMoney?.attemptedProviders, ["surf"]);
    assert.equal(
      (smartMoney?.data as { skill?: { name?: string } } | undefined)?.skill?.name,
      "surf"
    );
	    assert.equal(result.payload.report?.entities[0]?.label, "0xbdb3...47b6");
	    assert.match(
	      result.payload.report?.executiveSummary ?? "",
	      /candidate smart-money wallet-flow for token from Surf Chat Completions ability output/i
	    );
	    assert.doesNotMatch(result.payload.report?.title ?? "", /\$MNT/i);
    assert.equal(
      result.payload.report?.tables.find((table) => table.id === "smart-money-table")?.title,
      "Candidate Smart-Money Wallets"
    );
    assert.doesNotMatch(result.content, /Nansen returned no usable/i);
  } finally {
    restore();
  }
});

test("Surf credit errors use local CLI SQL before Dune fallback", async () => {
  const cli = createMockSurfCli([
    {
      priceUsd: 0.118458982,
      providerAmountUsd: 3529720.85,
      signal: "DEX buy",
      tokenAddress: "0x912CE59144191C1204E64559FE8253a0e49E6548",
      tokenBoughtAmountRaw: "29797832970000000000000000",
      tokenDecimals: 18,
      tokenSymbol: "ARB",
      trades: 2329,
      wallet: "0x01989c93890aed05a63d179b03424997075b6acf",
      window: "2026-05-16 to 2026-05-19",
    },
  ]);
  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      return jsonResponse(
        {
          error: {
            code: "PAID_BALANCE_ZERO",
            message: "insufficient credits",
          },
        },
        { status: 402, statusText: "Payment Required" }
      );
    }

    throw new Error(`Unexpected request after Surf CLI fallback: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        SURF_API_KEY: "surf-paid-empty",
        SURF_CLI_FALLBACK_ENABLED: "true",
        SURF_CLI_PATH: cli.path,
        SURF_CLI_TEST_CALLS: cli.callsPath,
        SURF_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: "Find smart-money accumulation on Arbitrum",
        })
    );
    const smartMoney = result.payload.tools.find(
      (tool) => tool.commandId === "smart_money.surf_smart_money_research"
    );
    const call = JSON.parse(
      readFileSync(cli.callsPath, "utf8").trim()
    ) as {
      args: string[];
      stdin: string;
    };
    const stdin = JSON.parse(call.stdin) as { sql?: string };

    assert.equal(smartMoney?.provider, "surf");
    assert.equal(smartMoney?.status, "success");
    assert.deepEqual(smartMoney?.attemptedProviders, ["surf"]);
    assert.equal(
      (smartMoney?.data as { sqlFallback?: { transport?: string } } | undefined)
        ?.sqlFallback?.transport,
      "cli"
    );
    assert.ok(call.args.includes("onchain-sql"));
    assert.match(stdin.sql ?? "", /agent\.arbitrum_dex_trades/);
    assert.equal(
      result.payload.report?.entities[0]?.metrics.tokenFlow,
      "29.8M ARB"
    );
  } finally {
    restore();
    cli.cleanup();
  }
});

test("generic Mantle smart-money prompt stays chain-level and does not auto-resolve MNT", async () => {
  const executedSql: string[] = [];
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string; role?: string }>;
      };
      const prompt = body.messages?.map((message) => message.content ?? "").join("\n") ?? "";

      assert.match(prompt, /Analysis chain: mantle/i);
      assert.match(prompt, /No token target was resolved/i);
      assert.doesNotMatch(prompt, /0x3c3a81e81dc49A522A592e7622A7E711c06bf354/i);
      assert.doesNotMatch(prompt, /use Ethereum DEX trades for MNT/i);

      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bottomLine: "Chat ability did not return rows.",
                rows: [],
                sections: [
                  {
                    markdown: "Mantle-native rows were empty.",
                    title: "Read",
                  },
                ],
                summary: "No direct rows.",
              }),
            },
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      return jsonResponse({ data: [] });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/sql/execute"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { sql?: string };
      executedSql.push(body.sql ?? "");

      return jsonResponse({
        execution_id:
          executedSql.length === 1
            ? "01KMANTLEPRIMARY"
            : executedSql.length === 2
              ? "01KMANTLERELAXED"
              : "01KMANTLEEXTERNALCEX",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLEPRIMARY/status"
    ) {
      return jsonResponse({
        execution_id: "01KMANTLEPRIMARY",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLEPRIMARY/results"
    ) {
      return jsonResponse({
        result: {
          rows: [],
        },
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLERELAXED/status"
    ) {
      return jsonResponse({
        execution_id: "01KMANTLERELAXED",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLERELAXED/results"
    ) {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 42000,
              category: "non-stable token accumulation",
              signal: "DEX buy",
              sourceChain: "mantle",
              sourceTable: "dex.trades",
              status: "large-flow watchlist",
              token: "PUFF",
              trades: 12,
              usd_value: 25000,
              wallet: "0xb33b00000000000000000000000000000000a52e",
              window: "2026-05-16 to 2026-05-21",
            },
          ],
        },
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLEEXTERNALCEX/status"
    ) {
      return jsonResponse({
        execution_id: "01KMANTLEEXTERNALCEX",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLEEXTERNALCEX/results"
    ) {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 177700,
              category: "external token CEX withdrawal",
              signal: "CEX withdrawal",
              smartMoneyStatus: "candidate_smart_money",
              sourceCex: "Bybit",
              sourceChain: "ethereum",
              sourceTable: "cex token transfers: tokens.transfers + labels.addresses",
              status: "candidate smart-money",
              token: "MNT",
              transfers: 3,
              usd_value: 120900,
              wallet: "0xbdb30000000000000000000000000000000047b6",
              window: "2026-05-21 to 2026-05-21",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        SURF_API_KEY: "surf-test-key",
        SURF_ENABLED: "true",
        NANSEN_API_KEY: "nansen-test-key",
        NANSEN_ENABLED: "true",
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: "Find smart-money accumulation on Mantle auto resolve",
        })
    );
    const smartMoney = result.payload.tools.find(
      (tool) => tool.commandId === "smart_money.surf_smart_money_research"
    );
    const combinedText = [
      result.content,
      result.payload.answer,
      result.payload.report?.executiveSummary,
      result.payload.report?.bottomLine,
      result.payload.recommendation,
    ].join("\n");

    assert.equal(smartMoney?.provider, "dune");
    assert.equal(smartMoney?.status, "success");
    assert.deepEqual(smartMoney?.attemptedProviders, ["surf", "dune"]);
    assert.equal(result.payload.report?.entities[0]?.label, "0xb33b00000000000000000000000000000000a52e");
    assert.equal(
      result.payload.report?.tables.find((table) => table.id === "smart-money-table")?.rows[0]?.Token,
      "PUFF"
    );
    assert.equal(
      result.payload.report?.title,
      "Mantle Smart-Money Accumulation Watch"
    );
    assert.equal(
      result.payload.report?.tables.find((table) => table.id === "smart-money-table")?.title,
      "Candidate Smart-Money Wallets"
    );
    assert.equal(
      result.payload.report?.tables.find((table) => table.id === "cex-withdrawal-table")?.rows[0]?.["Flow type"],
      "CEX withdrawal from Bybit"
    );
    assert.doesNotMatch(
      String((smartMoney?.data as { content?: unknown } | undefined)?.content ?? ""),
      /did not return rows|No direct rows/i
    );
    assert.match(combinedText, /large DEX-buy|large-flow watchlist/i);
    assert.match(executedSql[0] ?? "", /blockchain = 'mantle'/);
    assert.match(executedSql[0] ?? "", /amount_usd >= 10000/);
    assert.match(executedSql[0] ?? "", /date_add\('day', -7, current_timestamp\)/);
    assert.match(executedSql[1] ?? "", /blockchain = 'mantle'/);
    assert.match(executedSql[1] ?? "", /amount_usd >= 1000/);
    assert.match(executedSql[1] ?? "", /date_add\('day', -30, current_timestamp\)/);
    assert.doesNotMatch(executedSql[0] ?? "", /blockchain = 'ethereum'/);
    assert.doesNotMatch(executedSql[1] ?? "", /blockchain = 'ethereum'/);
    assert.match(executedSql[2] ?? "", /tokens\.transfers/);
    assert.match(executedSql[2] ?? "", /labels\.addresses/);
    assert.match(executedSql[2] ?? "", /blockchain = 'ethereum'/);
    assert.match(
      executedSql[2] ?? "",
      /0x3c3a81e81dc49a522a592e7622a7e711c06bf354/i
    );
    assert.doesNotMatch(combinedText, /Rerun pipeline/i);
    assert.doesNotMatch(combinedText, /Dune query/i);
  } finally {
    restore();
  }
});

test("generic Arbitrum smart-money prompt stays chain-level and ranks broad token rows", async () => {
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string; role?: string }>;
      };

      assert.ok(
        body.messages?.some((message) =>
          message.content?.includes("Auto-resolved scope: broad token accumulation on Arbitrum")
        )
      );
      assert.ok(
        !body.messages?.some((message) =>
          message.content?.includes("0x912CE59144191C1204E64559FE8253a0e49E6548")
        )
      );

      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bottomLine: "Chat ability did not return rows.",
                rows: [],
                sections: [],
                summary: "No direct rows.",
              }),
            },
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/onchain/sql"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        sql?: string;
      };

      assert.match(body.sql ?? "", /agent\.arbitrum_dex_trades/);
      assert.match(body.sql ?? "", /agent\.arbitrum_prices_day/);
      assert.match(body.sql ?? "", /token_bought_amount_raw/);
      assert.doesNotMatch(
        body.sql ?? "",
        /0x912ce59144191c1204e64559fe8253a0e49e6548/
      );

      return jsonResponse({
        data: [
          {
            priceUsd: 0.118458982,
            providerAmountUsd: 3529720.85,
            signal: "DEX buy",
            tokenAddress: "0x912CE59144191C1204E64559FE8253a0e49E6548",
            tokenBoughtAmountRaw: "29797832970000000000000000",
            tokenDecimals: 18,
            tokenSymbol: "ARB",
            trades: 2329,
            wallet: "0x01989c93890aed05a63d179b03424997075b6acf",
            window: "2026-05-16 to 2026-05-19",
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        SURF_API_KEY: "surf-test-key",
        SURF_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: "Find smart-money accumulation on Arbitrum",
        })
    );
    const smartMoney = result.payload.tools.find(
      (tool) => tool.commandId === "smart_money.surf_smart_money_research"
    );
    const combinedText = [
      result.content,
      result.payload.report?.title,
      result.payload.report?.executiveSummary,
      result.payload.report?.bottomLine,
      result.payload.recommendation,
    ].join("\n");

    assert.equal(result.payload.plan.chain, "arbitrum");
    assert.equal(smartMoney?.status, "success");
    assert.equal(
      smartMoney?.sourceUrl,
      "https://docs.asksurf.ai/data-api/onchain/sql"
    );
    assert.ok(
      !result.payload.providerTrace?.some(
        (entry) => entry.provider === "surf" && entry.status === "skipped"
      )
    );
    assert.equal(result.payload.report?.title, "Arbitrum Smart-Money Accumulation Watch");
    assert.equal(result.payload.report?.entities[0]?.label, "0x0198...6acf");
    assert.equal(
      result.payload.report?.entities[0]?.metrics.tokenFlow,
      "29.8M ARB"
    );
    assert.equal(result.payload.report?.entities[0]?.category, "large-flow-watchlist");
    assert.equal(
      result.payload.report?.tables.find((table) => table.id === "smart-money-table")?.title,
      "Large DEX-Buy Watchlist"
    );
    assert.doesNotMatch(combinedText, /Rerun input|Dune query|wallet-flow rows were not available/i);
  } finally {
    restore();
  }
});

test("generic Ethereum smart-money prompt prioritizes non-stable token accumulation", async () => {
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string; role?: string }>;
      };

      assert.ok(
        body.messages?.some((message) =>
          message.content?.includes("Auto-resolved scope: broad token accumulation on Ethereum")
        )
      );

      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bottomLine: "Chat ability did not return rows.",
                rows: [],
                sections: [],
                summary: "No direct rows.",
              }),
            },
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/onchain/sql"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        sql?: string;
      };

      assert.match(body.sql ?? "", /agent\.ethereum_dex_trades/);
      assert.match(body.sql ?? "", /agent\.ethereum_prices_day/);
      assert.doesNotMatch(body.sql ?? "", /token_bought_address\) =/);

      return jsonResponse({
        data: [
          {
            priceUsd: 1,
            providerAmountUsd: 5000000,
            signal: "DEX buy",
            tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            tokenBoughtAmountRaw: "5000000000000",
            tokenDecimals: 6,
            tokenSymbol: "USDC",
            trades: 20,
            wallet: "0x1111111111111111111111111111111111111111",
            window: "2026-05-16 to 2026-05-21",
          },
          {
            priceUsd: 4000,
            providerAmountUsd: 4000000,
            signal: "DEX buy",
            tokenAddress: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
            tokenBoughtAmountRaw: "1000000000000000000000",
            tokenDecimals: 18,
            tokenSymbol: "WETH",
            trades: 12,
            wallet: "0x2222222222222222222222222222222222222222",
            window: "2026-05-16 to 2026-05-21",
          },
          {
            priceUsd: 0.00001,
            providerAmountUsd: 50000,
            signal: "DEX buy",
            tokenAddress: "0x6982508145454ce325ddbe47a25d4ec3d2311933",
            tokenBoughtAmountRaw: "5000000000000000000000000000",
            tokenDecimals: 18,
            tokenSymbol: "PEPE",
            trades: 9,
            wallet: "0x3333333333333333333333333333333333333333",
            window: "2026-05-16 to 2026-05-21",
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        SURF_API_KEY: "surf-test-key",
        SURF_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: "Find smart-money accumulation on Ethereum",
        })
    );

    assert.equal(result.payload.plan.chain, "ethereum");
    assert.equal(
      result.payload.report?.entities[0]?.metrics.tokenSymbol,
      "PEPE"
    );
    assert.equal(
      result.payload.report?.entities[0]?.metrics.tokenCategory,
      "non-stable-token-accumulation"
    );
    assert.ok(
      result.payload.report?.entities.some(
        (entity) => entity.metrics.tokenCategory === "stablecoin-dry-powder-flow"
      )
    );
    assert.ok(
      result.payload.report?.entities.some(
        (entity) => entity.metrics.tokenCategory === "wrapped-major-asset-flow"
      )
    );
    assert.equal(
      result.payload.report?.tables.find((table) => table.id === "smart-money-table")?.title,
      "Large DEX-Buy Watchlist"
    );
  } finally {
    restore();
  }
});

test("explicit token-address smart-money prompt uses chain DEX SQL fallback", async () => {
  const usdcAddress = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string; role?: string }>;
      };

      assert.ok(
        body.messages?.some((message) =>
          message.content?.includes(`Token address: ${usdcAddress}`)
        )
      );

      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                rows: [],
                sections: [],
                summary: "No direct rows.",
              }),
            },
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/onchain/sql"
    ) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        sql?: string;
      };

      assert.match(body.sql ?? "", /agent\.arbitrum_dex_trades/);
      assert.match(body.sql ?? "", /agent\.arbitrum_prices_day/);
      assert.match(body.sql ?? "", new RegExp(usdcAddress.toLowerCase()));

      return jsonResponse({
        data: [
          {
            priceUsd: 1,
            providerAmountUsd: 940000,
            signal: "DEX buy",
            tokenAddress: usdcAddress,
            tokenBoughtAmountRaw: "940000000000",
            tokenDecimals: 6,
            tokenSymbol: "USDC",
            trades: 41,
            wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            window: "2026-05-22 to 2026-05-23",
          },
        ],
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        SURF_API_KEY: "surf-test-key",
        SURF_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: `Find smart-money accumulation for USDC on Arbitrum ${usdcAddress}`,
        })
    );

    assert.equal(result.payload.plan.chain, "arbitrum");
    assert.equal(result.payload.report?.title, "Arbitrum ($USDC) - Smart-Money Accumulation Watch");
    assert.equal(
      result.payload.report?.entities[0]?.metrics.tokenFlow,
      "940K USDC"
    );
    assert.equal(
      result.payload.report?.tables.find((table) => table.id === "smart-money-table")?.title,
      "Large DEX-Buy Watchlist"
    );
    assert.equal(
      result.payload.report?.entities[0]?.metrics.tokenCategory,
      "stablecoin-dry-powder-flow"
    );
  } finally {
    restore();
  }
});

test("empty Surf ability smart-money rows fall back to Nansen and Dune rows", async () => {
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      assert.equal(init?.method, "POST");

      return jsonResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({
                bottomLine: "Rows were not available.",
                rows: [],
                sections: [
                  {
                    markdown: "No direct rows were returned.",
                    title: "Read",
                  },
                ],
                summary: "No row-level data.",
              }),
            },
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/onchain/sql"
    ) {
      return jsonResponse({
        data: [],
        meta: {
          cached: false,
          credits_used: 5,
        },
      });
    }

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      return jsonResponse({ data: [] });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/query/123456/results"
    ) {
      return jsonResponse({
        result: {
          rows: [
            {
              address: "0xb33b00000000000000000000000000000000a52e",
              netMnt: "179.4K",
              netUsd: "$119.4K",
              signal: "DEX buy",
              trades: 134,
              window: "2026-05-20 to 2026-05-21",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_DEFAULT_QUERY_ID: "123456",
        NANSEN_API_KEY: "nansen-test-key",
        NANSEN_ENABLED: "true",
        SURF_API_KEY: "surf-test-key",
        SURF_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: "Find smart-money accumulation on Mantle query 123456",
        })
    );
    const smartMoney = result.payload.tools.find(
      (tool) => tool.commandId === "smart_money.surf_smart_money_research"
    );

    assert.equal(smartMoney?.provider, "dune");
    assert.equal(smartMoney?.status, "success");
    assert.deepEqual(smartMoney?.attemptedProviders, ["surf", "dune"]);
    assert.match(smartMoney?.fallbackReason ?? "", /surf:/i);
    assert.equal(result.payload.report?.entities[0]?.label, "0xb33b00000000000000000000000000000000a52e");
  } finally {
    restore();
  }
});

test("explicit MNT token request uses Ethereum MNT only as external low-confidence fallback", async () => {
  const executedSql: string[] = [];
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.asksurf.ai" &&
      parsed.pathname === "/gateway/v1/chat/completions"
    ) {
      return jsonResponse(
        {
          error_code: "PAID_BALANCE_ZERO",
          message: "insufficient credit",
          success: false,
        },
        { status: 402, statusText: "Payment Required" }
      );
    }

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      return jsonResponse({ data: [] });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/sql/execute"
    ) {
      const body = JSON.parse(String(init?.body)) as { sql: string };
      executedSql.push(body.sql);

      return jsonResponse({
        execution_id:
          executedSql.length === 1
            ? "01KMANTLEEMPTY"
            : executedSql.length === 2
              ? "01KMANTLERELAXEDEMPTY"
              : "01KMNTETHROWS",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLEEMPTY/status"
    ) {
      return jsonResponse({
        execution_id: "01KMANTLEEMPTY",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLEEMPTY/results"
    ) {
      return jsonResponse({ result: { rows: [] } });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLERELAXEDEMPTY/status"
    ) {
      return jsonResponse({
        execution_id: "01KMANTLERELAXEDEMPTY",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMANTLERELAXEDEMPTY/results"
    ) {
      return jsonResponse({ result: { rows: [] } });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMNTETHROWS/status"
    ) {
      return jsonResponse({
        execution_id: "01KMNTETHROWS",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/execution/01KMNTETHROWS/results"
    ) {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 179400,
              category: "non-stable token accumulation",
              signal: "CEX withdrawal",
              sourceCex: "Bybit",
              sourceChain: "ethereum",
              sourceTable: "cex.flows",
              status: "candidate smart-money",
              token: "MNT",
              transfers: 3,
              usd_value: 119400,
              wallet: "0xb33b00000000000000000000000000000000a52e",
              window: "2026-05-20 to 2026-05-21",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    const result = await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
        NANSEN_API_KEY: "nansen-test-key",
        NANSEN_ENABLED: "true",
        SURF_API_KEY: "surf-test-key",
        SURF_ENABLED: "true",
      },
      async () =>
        runOnChainToolWorkflow({
          chain: "mantle",
          context: [],
          message: "Find smart-money accumulation for MNT on Mantle",
        })
    );
    const smartMoney = result.payload.tools.find(
      (tool) => tool.commandId === "smart_money.surf_smart_money_research"
    );
    const candidateTable = result.payload.report?.tables.find(
      (table) => table.id === "smart-money-table"
    );
    const limits = result.payload.report?.sections.find(
      (section) => section.id === "limits"
    )?.markdown ?? "";

    assert.equal(smartMoney?.provider, "dune");
    assert.equal(smartMoney?.status, "success");
    assert.deepEqual(smartMoney?.attemptedProviders, ["surf", "dune"]);
    assert.match(smartMoney?.summary ?? "", /external low-confidence token signal/i);
    assert.match(result.payload.report?.title ?? "", /Mantle \(\$MNT\)/);
    assert.ok(candidateTable);
    assert.equal(candidateTable?.rows[0]?.Token, "MNT");
    assert.match(limits, /Ethereum/i);
    assert.match(limits, /external token context|External token signal/i);
    assert.match(limits, /not Mantle chain-level activity/i);
    assert.match(executedSql[0] ?? "", /blockchain = 'mantle'/);
    assert.match(executedSql[0] ?? "", /upper\(token_bought_symbol\) = 'MNT'/);
    assert.match(executedSql[1] ?? "", /blockchain = 'mantle'/);
    assert.match(executedSql[1] ?? "", /upper\(token_bought_symbol\) = 'MNT'/);
    assert.match(executedSql[1] ?? "", /amount_usd >= 1000/);
    assert.match(executedSql[2] ?? "", /blockchain = 'ethereum'/);
    assert.match(
      executedSql[2] ?? "",
      /token_bought_address = 0x3c3a81e81dc49a522a592e7622a7e711c06bf354/i
    );
  } finally {
    restore();
  }
});

test("empty Nansen smart-money rows fall back to Dune rows", async () => {
  const result = await runSmartMoneyWorkflowWithMock((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      assert.equal(init?.method, "POST");

      return jsonResponse({
        data: [],
        pagination: {
          is_last_page: true,
          page: 1,
          per_page: 10,
        },
      });
    }

    const duneSql = mockCompletedDuneSqlRows(parsed, init, [
      {
        address: "0x2ca9000000000000000000000000000000003a4c",
        net_flow_7d_usd: 250000,
        symbol: "MNT",
      },
    ]);

    if (duneSql) {
      return duneSql;
    }

    return jsonResponse({ ok: true });
  });

  const smartMoney = result.payload.tools.find(
    (tool) => tool.commandId === "smart_money.smart_money_dune"
  );

  assert.equal(smartMoney?.provider, "dune");
  assert.equal(smartMoney?.status, "success");
  assert.deepEqual(smartMoney?.attemptedProviders, ["dune"]);
  assert.equal(smartMoney?.fallbackReason, undefined);
  assert.ok(result.payload.report?.entities.length);
  assert.ok(
    result.payload.providerTrace?.some(
      (entry) => entry.provider === "dune" && entry.status === "success"
    )
  );
});

test("empty Nansen and Dune smart-money rows stay directional and friendly", async () => {
  const result = await runSmartMoneyWorkflowWithMock((url) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      return jsonResponse({
        data: [],
        pagination: {
          is_last_page: true,
          page: 1,
          per_page: 10,
        },
      });
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/query/123456/results"
    ) {
      return jsonResponse({
        result: {
          rows: [],
        },
      });
    }

    return jsonResponse({ ok: true });
  }, "Find smart-money accumulation on Mantle empty providers query 123456");
  const smartMoney = result.payload.tools.find(
    (tool) => tool.commandId === "smart_money.smart_money_dune"
  );
  const combinedText = [
    result.content,
    result.payload.answer,
    result.payload.report?.executiveSummary,
    result.payload.report?.bottomLine,
    result.payload.recommendation,
  ].join("\n");

  assert.equal(smartMoney?.status, "failed");
  assert.equal(result.payload.report?.kind, "smart-money");
  assert.equal(result.payload.report?.tables.length, 0);
  assert.match(result.payload.report?.executiveSummary ?? "", /Smart-money signal is still weak/i);
  assert.match(combinedText, /wallet-flow rows/i);
  assert.match(combinedText, /unavailable checks|Standard follow-up checks/i);
  assert.doesNotMatch(combinedText, /specific Mantle token, wallet address, or configured Dune query/i);
  assert.doesNotMatch(combinedText, /Belum ada bukti akumulasi terverifikasi/i);
  assert.doesNotMatch(combinedText, /usable live evidence/i);
});

test("on-chain workflow preserves fallback provider attribution", async () => {
  const fallbackResult = await runSmartMoneyWorkflowWithMock((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      assert.equal(init?.method, "POST");

      return jsonResponse(
        {
          error: "upstream unavailable",
        },
        {
          status: 503,
          statusText: "Service Unavailable",
        }
      );
    }

    const duneSql = mockCompletedDuneSqlRows(parsed, init, [
      {
        address: "0x2ca9000000000000000000000000000000003a4c",
        net_flow_7d_usd: 250000,
        symbol: "MNT",
      },
    ]);

    if (duneSql) {
      return duneSql;
    }

    return jsonResponse({ ok: true });
  }, "Find smart-money accumulation on Mantle scenario one");
  const fallbackSmartMoney = fallbackResult.payload.tools.find(
    (tool) => tool.commandId === "smart_money.smart_money_dune"
  );

  assert.equal(fallbackSmartMoney?.provider, "dune");
  assert.deepEqual(fallbackSmartMoney?.attemptedProviders, ["dune"]);
  assert.equal(fallbackSmartMoney?.fallbackReason, undefined);
  assert.equal(fallbackSmartMoney?.scope, "legacy-default");
  assert.ok(
    fallbackResult.payload.providerTrace?.some(
      (entry) => entry.provider === "dune" && entry.status === "success"
    )
  );

  const failedResult = await runSmartMoneyWorkflowWithMock((url, init) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.nansen.ai" &&
      parsed.pathname === "/api/v1/smart-money/netflow"
    ) {
      assert.equal(init?.method, "POST");

      return jsonResponse(
        {
          error: "invalid request",
          message: "Unknown field",
        },
        {
          status: 422,
          statusText: "Unprocessable Entity",
        }
      );
    }

    if (
      parsed.hostname === "api.dune.com" &&
      parsed.pathname === "/api/v1/sql/execute"
    ) {
      return jsonResponse(
        {
          error: "query id missing",
        },
        {
          status: 400,
          statusText: "Bad Request",
        }
      );
    }

    return jsonResponse({ ok: true });
  }, "Find smart-money accumulation on Mantle scenario two");
  const failedSmartMoney = failedResult.payload.tools.find(
    (tool) => tool.commandId === "smart_money.smart_money_dune"
  );

  assert.equal(failedSmartMoney?.status, "failed");
  assert.equal(failedSmartMoney?.provider, "dune");
  assert.deepEqual(failedSmartMoney?.attemptedProviders, ["dune", "nansen"]);
  assert.match(failedSmartMoney?.fallbackReason ?? "", /dune:/i);
  assert.equal(failedResult.payload.report?.kind, "smart-money");
  assert.equal(failedResult.payload.report?.tables.length, 0);
});

test("on-chain workflow emits a liquidity anomaly report when pair metrics are available", async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.dexscreener.com" &&
      parsed.pathname ===
        "/latest/dex/pairs/mantle/0xeAfc4D6d4c3391Cd4Fc10c85D2f5f972d58C0dD5"
    ) {
      return jsonResponse({
        pairs: [
          {
            baseToken: { symbol: "BSB" },
            liquidity: { usd: 843200 },
            pairAddress: "0xeAfc4D6d4c3391Cd4Fc10c85D2f5f972d58C0dD5",
            priceChange: { h24: 21.6 },
            quoteToken: { symbol: "USDT0" },
            txns: { h24: { buys: 3440, sells: 3440 } },
            volume: { h24: 1870000 },
          },
        ],
      });
    }

    return jsonResponse({ ok: true });
  });

  try {
    const result = await runOnChainToolWorkflow({
      chain: "mantle",
      context: [],
      message:
        "Detect liquidity anomaly on Mantle pair 0xeAfc4D6d4c3391Cd4Fc10c85D2f5f972d58C0dD5",
    });

    assert.equal(result.payload.report?.kind, "liquidity-anomaly");
    assert.equal(result.payload.report?.entities[0]?.label, "BSB / USDT0");
    assert.equal(result.payload.report?.tables[0]?.id, "anomaly-table");
  } finally {
    restore();
  }
});

test("on-chain workflow emits a liquidity anomaly report for generic Celo pair scans when GeckoTerminal fails", async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.coingecko.com" &&
      parsed.pathname === "/api/v3/onchain/networks"
    ) {
      return jsonResponse({
        data: [
          {
            attributes: {
              name: "Celo",
              coingecko_asset_platform_id: "celo",
            },
            id: "celo",
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.coingecko.com" &&
      (parsed.pathname === "/api/v3/onchain/networks/celo/trending_pools" ||
        parsed.pathname === "/api/v3/onchain/networks/celo/new_pools")
    ) {
      return jsonResponse(
        { error: "missing api key" },
        {
          status: 401,
          statusText: "Unauthorized",
        }
      );
    }

    if (
      parsed.hostname === "api.dexscreener.com" &&
      parsed.pathname === "/latest/dex/search"
    ) {
      assert.equal(parsed.searchParams.get("q"), "Celo");

      return jsonResponse({
        pairs: [
          {
            baseToken: { symbol: "BASE" },
            chainId: "base",
            liquidity: { usd: 999999 },
            pairAddress: "0x0000000000000000000000000000000000000001",
            priceChange: { h24: 80 },
            quoteToken: { symbol: "USDC" },
            txns: { h24: { buys: 3000, sells: 3000 } },
            volume: { h24: 5000000 },
          },
          {
            baseToken: { symbol: "CELO" },
            chainId: "celo",
            liquidity: { usd: 8251.71 },
            pairAddress: "0x2d70cBAbf4d8e61d5317b62cBe912935FD94e0FE",
            priceChange: { h24: -5.76 },
            quoteToken: { symbol: "USDm" },
            txns: { h24: { buys: 1090, sells: 991 } },
            volume: { h24: 51706.63 },
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.dexscreener.com" &&
      parsed.pathname === "/token-boosts/latest/v1"
    ) {
      return jsonResponse([]);
    }

    return jsonResponse({ ok: true });
  });

  try {
    const result = await runOnChainToolWorkflow({
      chain: "mantle",
      context: [],
      message: "Detect liquidity anomalies on Celo DEX pairs",
    });

    assert.equal(result.payload.report?.kind, "liquidity-anomaly");
    assert.equal(result.payload.report?.entities[0]?.label, "CELO / USDm");
    assert.equal(result.payload.report?.tables[0]?.id, "anomaly-table");
    assert.ok(
      !result.payload.report?.entities.some((entity) =>
        String(entity.metrics.pairAddress).includes("0000000000000001")
      )
    );
  } finally {
    restore();
  }
});

test("on-chain workflow emits a DeFi yield report for generic Mantle ranking prompts", async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    if (parsed.hostname === "api.llama.fi" && parsed.pathname === "/protocols") {
      return jsonResponse([
        {
          chainTvls: {
            Mantle: 136579045.42,
          },
          chains: ["Ethereum", "Mantle"],
          change_1d: -5.42,
          change_7d: -6.36,
          name: "Aave V3",
          slug: "aave-v3",
        },
        {
          chainTvls: {
            Base: 999999999,
          },
          chains: ["Base"],
          name: "Aerodrome",
          slug: "aerodrome",
        },
      ]);
    }

    if (parsed.hostname === "api.llama.fi" && parsed.pathname === "/v2/chains") {
      return jsonResponse([{ name: "Mantle", tvl: 755000000 }]);
    }

    if (parsed.hostname === "stablecoins.llama.fi") {
      return jsonResponse({ peggedAssets: [] });
    }

    if (parsed.hostname === "yields.llama.fi" && parsed.pathname === "/pools") {
      return jsonResponse({
        data: [
          {
            apy: 5.53,
            apyPct1D: -0.4,
            apyPct7D: 0.09,
            chain: "Mantle",
            pool: "aave-v3-usdt0",
            project: "aave-v3",
            symbol: "USDT0",
            tvlUsd: 29030215,
          },
          {
            apy: 30,
            chain: "Base",
            pool: "aerodrome-usdc",
            project: "aerodrome",
            symbol: "USDC",
            tvlUsd: 9000000,
          },
        ],
      });
    }

    return jsonResponse({ ok: true });
  });

  try {
    const result = await runOnChainToolWorkflow({
      chain: "mantle",
      context: [],
      message: "Rank Mantle protocols by TVL and yield momentum",
    });

    assert.equal(result.payload.report?.kind, "defi-yield");
    assert.equal(result.payload.report?.entities[0]?.label, "Aave V3");
    assert.equal(result.payload.report?.tables[0]?.id, "yield-table");
    assert.ok(
      !result.payload.report?.entities.some((entity) =>
        entity.label.toLowerCase().includes("aerodrome")
      )
    );
  } finally {
    restore();
  }
});

test("on-chain workflow emits a token discovery report for generic analysis chains", async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    if (
      parsed.hostname === "api.dexscreener.com" &&
      parsed.pathname === "/token-boosts/top/v1"
    ) {
      return jsonResponse([
        {
          chainId: "solana",
          tokenAddress: "So11111111111111111111111111111111111111112",
          totalAmount: 800,
          url: "https://dexscreener.com/solana/So11111111111111111111111111111111111111112",
        },
        {
          chainId: "base",
          tokenAddress: "0x0000000000000000000000000000000000000001",
          totalAmount: 9999,
          url: "https://dexscreener.com/base/0x0000000000000000000000000000000000000001",
        },
      ]);
    }

    if (
      parsed.hostname === "api.dexscreener.com" &&
      parsed.pathname === "/token-profiles/latest/v1"
    ) {
      return jsonResponse([
        {
          chainId: "solana",
          tokenAddress: "So11111111111111111111111111111111111111112",
          updatedAt: "2026-05-23T08:00:00.000Z",
          url: "https://dexscreener.com/solana/So11111111111111111111111111111111111111112",
        },
      ]);
    }

    if (parsed.hostname === "api.coingecko.com" && parsed.pathname === "/api/v3/search") {
      return jsonResponse({ coins: [] });
    }

    if (
      parsed.hostname === "api.coingecko.com" &&
      parsed.pathname === "/api/v3/onchain/networks"
    ) {
      return jsonResponse({
        data: [
          {
            attributes: {
              name: "Solana",
              coingecko_asset_platform_id: "solana",
            },
            id: "solana",
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.coingecko.com" &&
      parsed.pathname === "/api/v3/onchain/networks/solana/trending_pools"
    ) {
      return jsonResponse({
        data: [
          {
            attributes: {
              base_token_symbol: "SOLX",
              name: "SOLX / USDC",
              price_change_percentage: {
                h24: "21.5",
              },
              reserve_in_usd: "150000",
              volume_usd: {
                h24: "450000",
              },
            },
            id: "solana_pool_pool-sol",
            relationships: {
              base_token: {
                data: {
                  id: "solana_So11111111111111111111111111111111111111112",
                },
              },
            },
          },
        ],
      });
    }

    if (
      parsed.hostname === "api.coingecko.com" &&
      parsed.pathname === "/api/v3/onchain/networks/solana/new_pools"
    ) {
      return jsonResponse({ data: [] });
    }

    return jsonResponse({ ok: true });
  });

  try {
    const result = await runOnChainToolWorkflow({
      chain: "mantle",
      context: [],
      message: "token Solana yang sedang tren",
    });

    assert.equal(result.payload.report?.kind, "token-discovery");
    assert.equal(result.payload.report?.entities[0]?.label, "SOLX");
    assert.equal(result.payload.report?.tables[0]?.id, "token-discovery-table");
    assert.ok(
      !result.payload.report?.entities.some((entity) =>
        String(entity.metrics.tokenAddress).includes("0000000000000001")
      )
    );
  } finally {
    restore();
  }
});
