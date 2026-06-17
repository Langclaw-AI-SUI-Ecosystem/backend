import assert from "node:assert/strict";
import test from "node:test";

import { isExecutorAvailable } from "./executor";
import { buildChainResearchCapabilities } from "./capabilities";
import {
  detectChain,
  detectChainWithFallback,
  detectUnsupportedOnChainChain,
  resolveChain,
} from "./chains";
import { planOnChainTools } from "./planner";
import { getTokenBalances } from "./providers/alchemy";
import { getYieldPools } from "./providers/defillama";
import { searchPairs } from "./providers/dexscreener";
import {
  getLatestResult,
  getSmartMoneyDexBuyCandidates,
  getSuiAccumulationFlow,
} from "./providers/dune";
import { getAccountBalance } from "./providers/etherscan";
import { getTokenSecurity } from "./providers/goplus";
import { assertRegistryShape, onChainCommands } from "./registry";
import { onChainDomains } from "./types";
import { jsonResponse, mockFetch, withEnv } from "../../test/helpers";

test("on-chain registry exposes at least 83 commands across exactly 14 domains", () => {
  const shape = assertRegistryShape();

  assert.equal(shape.expectedDomainCount, 14);
  assert.equal(shape.domainCount, 14);
  assert.ok(shape.commandCount >= 83);
  assert.equal(onChainDomains.length, 14);
});

test("on-chain registry commands have schemas, executors, providers, and risk levels", () => {
  for (const command of onChainCommands) {
    assert.ok(command.id.includes("."));
    assert.equal(command.paramsSchema.type, "object");
    assert.ok(command.provider);
    assert.ok(command.riskLevel);
    assert.ok(isExecutorAvailable(command.executor), command.executor);
  }
});

test("Sui is the default on-chain intelligence network", () => {
  const defaultChain = resolveChain(undefined);
  const detected = detectChain("Find smart-money accumulation on Mantle");
  const mainnetDetected = detectChain("Find smart-money on Mantle mainnet");

  assert.equal(defaultChain.id, "sui");
  assert.equal(defaultChain.dexScreenerId, "sui");
  assert.equal(detected.id, "mantle");
  assert.equal(detected.etherscanId, 5000);
  assert.equal(mainnetDetected.id, "mantle");
});

test("Celo is a supported on-chain intelligence network", () => {
  const detected = detectChain("Find smart-money accumulation on Celo");
  const aliasDetected = detectChain("Find token flows on cello");
  const resolved = resolveChain("celo");

  assert.equal(detected.id, "celo");
  assert.equal(detected.chainId, 42220);
  assert.equal(detected.dexScreenerId, "celo");
  assert.equal(detected.alchemyNetwork, "celo-mainnet");
  assert.equal(aliasDetected.id, "celo");
  assert.equal(resolved.etherscanId, 42220);
});

test("prompt chain detection prefers explicit chain over UI fallback", () => {
  const explicitCelo = detectChainWithFallback(
    "Find whale flow on Celo",
    "mantle"
  );
  const explicitMantle = detectChainWithFallback(
    "Find whale flow on Mantle",
    "celo"
  );
  const fallbackSui = detectChainWithFallback(
    "Find whale flow on the selected chain",
    "sui-testnet"
  );

  assert.equal(explicitCelo.id, "celo");
  assert.equal(explicitMantle.id, "mantle");
  assert.equal(fallbackSui.id, "sui");
});

test("prompt chain detection ignores negated chain mentions", () => {
  const detected = detectChainWithFallback(
    "Find smart-money accumulation across Mantle chain only. Use Mantle wallet-flow rows. Do not use Ethereum MNT or external token fallback.",
    "mantle"
  );

  assert.equal(detected.id, "mantle");
});

test("on-chain guard allows explicitly supported analysis networks", () => {
  assert.equal(
    detectUnsupportedOnChainChain("Find trending tokens on Base"),
    null
  );
  assert.equal(
    detectUnsupportedOnChainChain("Find smart-money accumulation on Celo"),
    null
  );
  assert.equal(
    detectUnsupportedOnChainChain("Find trending tokens without naming a chain"),
    null
  );
  assert.equal(
    detectUnsupportedOnChainChain("Analyze SUI token on Ethereum"),
    null
  );
});

test("on-chain guard catches named unsupported chains without falling back to the product chain", () => {
  assert.deepEqual(
    detectUnsupportedOnChainChain("Find smart-money accumulation on Aptos"),
    {
      id: "aptos",
      name: "Aptos",
    }
  );
  assert.deepEqual(
    detectUnsupportedOnChainChain("Find smart-money accumulation on Aptos chain"),
    {
      id: "aptos",
      name: "Aptos",
    }
  );
});

test("chain capability registry marks configured Surf SQL chains as candidate ranking", async () => {
  await withEnv(
    {
      SURF_API_KEY: "surf-test-key",
      SURF_ENABLED: "true",
    },
    async () => {
      const capabilities = buildChainResearchCapabilities({
        chain: "arbitrum",
        domains: ["smart_money"],
        intent: "smart-money",
        query: "Find smart-money accumulation on Arbitrum",
      });

      assert.equal(capabilities.chain, "arbitrum");
      assert.equal(capabilities.smartMoney.status, "available");
      assert.equal(capabilities.smartMoney.mode, "candidate-ranking");
      assert.ok(
        capabilities.smartMoney.providers.some(
          (provider) =>
            provider.provider === "surf" &&
            provider.configured &&
            provider.status === "available" &&
            /SQL fallback/.test(provider.coverage)
        )
      );
    }
  );
});

test("chain capability registry downgrades chains without Surf SQL fallback", async () => {
  await withEnv(
    {
      SURF_API_KEY: "surf-test-key",
      SURF_ENABLED: "true",
    },
    async () => {
      const capabilities = buildChainResearchCapabilities({
        chain: "avalanche",
        domains: ["smart_money"],
        intent: "smart-money",
        query: "Find smart-money accumulation on Avalanche",
      });

      assert.equal(capabilities.chain, "avalanche");
      assert.equal(capabilities.smartMoney.status, "partial");
      assert.equal(capabilities.smartMoney.mode, "dynamic-ability");
      assert.ok(
        capabilities.smartMoney.limitations.some((item) =>
          /SQL fallback is not mapped/.test(item)
        )
      );
    }
  );
});

test("Celo plans skip GoPlus and include a provider-gap caveat", () => {
  const plan = planOnChainTools({
    chain: "celo",
    context: [],
    message:
      "Check Celo token security and holders for 0x471ece3750da237f93b8e339c536989b8978a438",
  });

  assert.equal(plan.chain, "celo");
  assert.equal(plan.chainId, 42220);
  assert.ok(!plan.commands.some((item) => item.command.provider === "goplus"));
  assert.ok(plan.providerGaps?.some((gap) => /GoPlus/.test(gap)));
});

test("planner attaches chain capability diagnostics to smart-money plans", async () => {
  await withEnv(
    {
      SURF_API_KEY: "surf-test-key",
      SURF_ENABLED: "true",
    },
    async () => {
      const plan = planOnChainTools({
        chain: "mantle",
        context: [],
        message: "Find smart-money accumulation on Avalanche",
      });

      assert.equal(plan.chain, "avalanche");
      assert.equal(plan.capabilities?.smartMoney.status, "partial");
      assert.equal(plan.capabilities?.smartMoney.mode, "dynamic-ability");
      assert.ok(
        plan.providerGaps?.some((gap) =>
          /row-level SQL fallback is not mapped/.test(gap)
        )
      );
    }
  );
});


test("planner routes Mantle alpha prompts into smart-money and yield domains", async () => {
  await withEnv(
    {
      DUNE_DEFAULT_QUERY_ID: "123456",
      NANSEN_API_KEY: "nansen-test-key",
      NANSEN_ENABLED: "true",
    },
    async () => {
    const smartMoneyPlan = planOnChainTools({
      context: [],
      message: "Find smart-money accumulation on Mantle query 123456",
    });
    const yieldPlan = planOnChainTools({
      context: [],
      message: "Rank Mantle protocols by TVL and yield momentum query 123456",
    });

    assert.equal(smartMoneyPlan.chain, "mantle");
    assert.equal(smartMoneyPlan.chainId, 5000);
    assert.ok(
      smartMoneyPlan.commands.some(
        (item) => item.command.domain === "smart_money"
      )
    );
    assert.equal(smartMoneyPlan.commands[0]?.command.provider, "dune");
    assert.ok(
      yieldPlan.commands.some(
        (item) =>
          item.command.domain === "defi_tvl" ||
          item.command.domain === "yield_pools"
      )
    );
    assert.ok(
      !yieldPlan.commands.some(
        (item) => item.command.id === "defi_tvl.defillama_protocol_detail"
      )
    );
    }
  );
});

test("planner routes Sui smart-money prompts through Sui-native Dune flow", async () => {
  await withEnv(
    {
      DUNE_API_KEY: "dune-test-key",
      SUI_BLOCKVISION_ENABLED: "false",
    },
    async () => {
      const plan = planOnChainTools({
        chain: "sui-testnet",
        context: [],
        message: "Find smart-money accumulation on Sui",
      });

      assert.equal(plan.chain, "sui");
      assert.equal(plan.intent, "smart-money");
      assert.equal(plan.commands[0]?.command.id, "smart_money.sui_dune_accumulation");
      assert.equal(plan.commands[0]?.command.provider, "dune");
      assert.ok(
        !plan.commands.some(
          (item) => item.command.id === "smart_money.smart_money_dune"
        )
      );
    }
  );
});

test("planner routes configured Mantle smart-money prompts through Surf first", async () => {
  await withEnv(
    {
      DUNE_DEFAULT_QUERY_ID: "123456",
      NANSEN_API_KEY: "nansen-test-key",
      NANSEN_ENABLED: "true",
      SURF_API_KEY: "surf-test-key",
      SURF_ENABLED: "true",
    },
    async () => {
      const plan = planOnChainTools({
        context: [],
        message: "Find smart-money accumulation on Mantle query 123456",
      });

      assert.equal(plan.intent, "smart-money");
      assert.equal(plan.commands[0]?.command.id, "smart_money.surf_smart_money_research");
      assert.equal(plan.commands[0]?.command.provider, "surf");
      assert.deepEqual(
        plan.commands[0]?.command.fallback?.map((item) => item.provider),
        ["dune", "nansen"]
      );
      assert.ok(
        !plan.commands.some(
          (item) => item.command.id === "smart_money.nansen_smart_money_netflow"
        )
      );
    }
  );
});

test("planner preserves Mantle smart-money scope with negated Ethereum fallback text", async () => {
  await withEnv(
    {
      SURF_API_KEY: "surf-test-key",
      SURF_ENABLED: "true",
    },
    async () => {
      const plan = planOnChainTools({
        chain: "mantle",
        context: [],
        message:
          "Find smart-money accumulation across Mantle chain only. Use Mantle on-chain wallet-flow rows only. Do not use Ethereum MNT, token-address fallback, or external low-confidence token context.",
      });

      assert.equal(plan.chain, "mantle");
      assert.equal(plan.intent, "smart-money");
      assert.equal(plan.analysisSource, "prompt");
      assert.ok(
        !plan.commands.some(
          (item) => item.command.domain === "wallet_portfolio"
        )
      );
      assert.ok(
        plan.commands.some((item) => item.command.domain === "smart_money")
      );
    }
  );
});

test("planner routes configured Arbitrum smart-money prompts through Surf first", async () => {
  await withEnv(
    {
      SURF_API_KEY: "surf-test-key",
      SURF_ENABLED: "true",
    },
    async () => {
      const plan = planOnChainTools({
        chain: "mantle",
        context: [],
        message: "Find smart-money accumulation on Arbitrum",
      });

      assert.equal(plan.intent, "smart-money");
      assert.equal(plan.chain, "arbitrum");
      assert.equal(plan.commands[0]?.command.id, "smart_money.surf_smart_money_research");
      assert.equal(plan.commands[0]?.command.provider, "surf");
      assert.ok(
        !plan.providerTrace?.some(
          (entry) => entry.provider === "surf" && entry.status === "skipped"
        )
      );
    }
  );
});

test("planner does not classify smart-money token prompts as wallet analysis by default", async () => {
  await withEnv(
    {
      DUNE_DEFAULT_QUERY_ID: "123456",
      NANSEN_API_KEY: "nansen-test-key",
      NANSEN_ENABLED: "true",
    },
    async () => {
      const plan = planOnChainTools({
        context: [],
        message: "Analyze smart-money accumulation for MNT on Mantle",
      });

      assert.equal(plan.chain, "mantle");
      assert.equal(plan.intent, "smart-money");
      assert.match(plan.query ?? "", /\bMNT\b/);
      assert.equal(plan.walletAddress, undefined);
      assert.ok(
        plan.commands.some(
          (item) =>
            item.command.domain === "smart_money" &&
            item.command.provider === "dune"
        )
      );
    }
  );
});

test("planner routes generic liquidity-anomaly prompts into GeckoTerminal discovery plus chain-scoped DEX search", () => {
  const plan = planOnChainTools({
    chain: "mantle",
    context: [],
    message: "Detect liquidity anomalies on Base DEX pairs",
  });

  assert.equal(plan.chain, "base");
  assert.equal(plan.query, "Base");
  assert.ok(
    plan.commands.some((item) => item.command.provider === "geckoterminal")
  );
  assert.ok(
    plan.commands.some((item) => item.command.id === "pair_liquidity.liquidity_pair_search")
  );
});

test("planner keeps Celo liquidity anomaly intent while adding DEX search fallback", () => {
  const plan = planOnChainTools({
    chain: "mantle",
    context: [],
    message: "Detect liquidity anomalies on Celo DEX pairs",
  });

  assert.equal(plan.chain, "celo");
  assert.equal(plan.intent, "trading-signal");
  assert.equal(plan.query, "Celo");
  assert.ok(
    plan.commands.some(
      (item) => item.command.id === "pair_liquidity.geckoterminal_network_trending_pools"
    )
  );
  assert.ok(
    plan.commands.some((item) => item.command.id === "pair_liquidity.liquidity_pair_search")
  );
});

test("planner records premium provider scope skips for the Sui product chain", () => {
  const plan = planOnChainTools({
    chain: "sui-testnet",
    context: [],
    message: "Find smart-money accumulation on Sui",
  });

  assert.ok(
    plan.providerTrace?.some(
      (entry) =>
        entry.provider === "nansen" &&
        entry.status === "skipped" &&
        entry.scope === "out-of-scope"
    )
  );
  assert.ok(
    plan.providerTrace?.some(
      (entry) =>
        entry.provider === "surf" &&
        entry.status === "skipped" &&
        entry.scope === "sui-premium"
    )
  );
  assert.ok(
    plan.providerTrace?.some(
      (entry) =>
        entry.provider === "elfa" &&
        entry.status === "skipped" &&
        entry.scope === "sui-premium"
    )
  );
});

test("planner only requests DeFiLlama protocol detail when a concrete slug is present", () => {
  const rankingPlan = planOnChainTools({
    context: [],
    message: "Rank Mantle protocols by TVL and yield momentum",
  });
  const protocolPlan = planOnChainTools({
    context: [],
    message: "Show protocol agni-finance TVL detail on Mantle",
  });

  assert.ok(
    !rankingPlan.commands.some(
      (item) => item.command.executor === "defillama.protocol"
    )
  );
  assert.ok(
    protocolPlan.commands.some(
      (item) => item.command.executor === "defillama.protocol"
    )
  );
});

test("planner keeps meaningful DeFi ranking query context", () => {
  const plan = planOnChainTools({
    context: [],
    message: "Rank Mantle protocols by TVL and yield momentum",
  });

  assert.equal(plan.rawQuery, "Rank Mantle protocols by TVL and yield momentum");
  assert.equal(plan.query, plan.rawQuery);
  assert.equal(plan.intent, "defi");
  assert.ok(
    plan.commands.some((item) => item.command.domain === "yield_pools")
  );
});

test("planner prefers explicit addresses in the latest message over prior context", () => {
  const plan = planOnChainTools({
    context: [
      {
        content:
          "Analyze holder flow and smart-money signals on Mantle token 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
        role: "user",
      },
    ],
    message:
      "Detect liquidity anomaly on Mantle pair 0xeAfc4D6d4c3391Cd4Fc10c85D2f5f972d58C0dD5",
  });

  assert.equal(
    plan.tokenAddress,
    "0xeAfc4D6d4c3391Cd4Fc10c85D2f5f972d58C0dD5"
  );
  assert.equal(plan.intent, "trading-signal");
  assert.ok(
    plan.commands.some(
      (item) => item.command.id === "pair_liquidity.pair_details"
    )
  );
  assert.ok(
    !plan.commands.some(
      (item) => item.command.id === "market_data.token_metadata"
    )
  );
});

test("planner does not let prior non-Mantle context override the latest Mantle prompt", () => {
  const plan = planOnChainTools({
    context: [
      {
        content: "Find trending tokens on Base",
        role: "user",
      },
    ],
    message:
      "Analyze holder flow and smart-money signals on Mantle token 0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34",
  });

  assert.equal(plan.chain, "mantle");
  assert.equal(plan.chainId, 5000);
});

test("DEX Screener provider searches pairs", async () => {
  const restore = mockFetch((url) => {
    assert.equal(new URL(url).pathname, "/latest/dex/search");

    return jsonResponse({
      pairs: [
        {
          baseToken: { symbol: "TEST" },
          chainId: "base",
          dexId: "uniswap",
          liquidity: { usd: 1000 },
          priceUsd: "1.23",
        },
      ],
    });
  });

  try {
    const result = await searchPairs({ chain: "base", query: "TEST" });

    assert.match(result.summary ?? "", /1 pairs returned/);
  } finally {
    restore();
  }
});

test("DEX Screener search filters pair results to the requested chain", async () => {
  const restore = mockFetch((url) => {
    assert.equal(new URL(url).pathname, "/latest/dex/search");

    return jsonResponse({
      pairs: [
        {
          baseToken: { symbol: "WRONG" },
          chainId: "solana",
          dexId: "raydium",
          liquidity: { usd: 999999 },
          priceUsd: "9.99",
        },
        {
          baseToken: { symbol: "MNT" },
          chainId: "mantle",
          dexId: "agni",
          liquidity: { usd: 1000 },
          priceUsd: "1.23",
        },
      ],
    });
  });

  try {
    const result = await searchPairs({ chain: "mantle", query: "MNT" });

    assert.match(result.summary ?? "", /filtered to mantle/);
    assert.match(result.summary ?? "", /Top pair: MNT on agni/);
    assert.equal((result.data as { pairs: unknown[] }).pairs.length, 1);
  } finally {
    restore();
  }
});

test("DeFiLlama provider filters yield pools by chain", async () => {
  const restore = mockFetch((url) => {
    assert.equal(new URL(url).pathname, "/pools");

    return jsonResponse({
      data: [
        { chain: "Base", project: "aave", tvlUsd: 100 },
        { chain: "Ethereum", project: "compound", tvlUsd: 200 },
      ],
    });
  });

  try {
    const result = await getYieldPools({ chain: "base" });

    assert.match(result.summary ?? "", /1 yield pools/);
  } finally {
    restore();
  }
});

test("Etherscan provider uses V2 chainid and API key", async () => {
  const restore = mockFetch((url) => {
    const parsed = new URL(url);

    assert.equal(parsed.pathname, "/v2/api");
    assert.equal(parsed.searchParams.get("chainid"), "8453");
    assert.equal(parsed.searchParams.get("module"), "account");
    assert.equal(parsed.searchParams.get("action"), "balance");
    assert.equal(parsed.searchParams.get("apikey"), "etherscan-test-key");

    return jsonResponse({ message: "OK", result: "1", status: "1" });
  });

  try {
    await withEnv({ ETHERSCAN_API_KEY: "etherscan-test-key" }, async () => {
      const result = await getAccountBalance({
        chain: "base",
        walletAddress: "0x1111111111111111111111111111111111111111",
      });

      assert.match(result.summary ?? "", /Fetched native account balance/);
    });
  } finally {
    restore();
  }
});

test("GoPlus provider calls token security endpoint", async () => {
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    assert.equal(parsed.pathname, "/api/v1/token_security/8453");
    assert.equal(init?.headers && typeof init.headers === "object", true);

    return jsonResponse({
      result: {
        "0x2222222222222222222222222222222222222222": {
          buy_tax: "0",
          is_honeypot: "0",
          sell_tax: "0",
        },
      },
    });
  });

  try {
    await withEnv(
      {
        GOPLUS_API_KEY: "goplus-key",
        GOPLUS_API_SECRET: "goplus-secret",
      },
      async () => {
        const result = await getTokenSecurity({
          chain: "base",
          tokenAddress: "0x2222222222222222222222222222222222222222",
        });

        assert.match(result.summary ?? "", /GoPlus token security/);
      }
    );
  } finally {
    restore();
  }
});

test("Alchemy provider posts token balance JSON-RPC request", async () => {
  const restore = mockFetch((url, init) => {
    assert.equal(url, "https://base-mainnet.g.alchemy.com/v2/alchemy-test-key");
    assert.equal(init?.method, "POST");

    const body = JSON.parse(String(init?.body)) as { method: string };
    assert.equal(body.method, "alchemy_getTokenBalances");

    return jsonResponse({ jsonrpc: "2.0", result: { tokenBalances: [] } });
  });

  try {
    await withEnv({ ALCHEMY_API_KEY: "alchemy-test-key" }, async () => {
      const result = await getTokenBalances({
        chain: "base",
        walletAddress: "0x3333333333333333333333333333333333333333",
      });

      assert.match(result.summary ?? "", /Alchemy/);
    });
  } finally {
    restore();
  }
});

test("Dune provider fetches latest configured query result", async () => {
  const restore = mockFetch((url, init) => {
    assert.equal(new URL(url).pathname, "/api/v1/query/123456/results");
    assert.ok(init?.headers);

    return jsonResponse({ result: { rows: [] } });
  });

  try {
    await withEnv({ DUNE_API_KEY: "dune-test-key" }, async () => {
      const result = await getLatestResult({ queryId: "123456" });

      assert.match(result.summary ?? "", /Dune query result/);
    });
  } finally {
    restore();
  }
});

test("Dune provider executes generated smart-money SQL from prompt parameters", async () => {
  const seenPaths: string[] = [];
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);
    seenPaths.push(parsed.pathname);

    if (parsed.pathname === "/api/v1/sql/execute") {
      assert.equal(init?.method, "POST");

      const body = JSON.parse(String(init?.body)) as {
        performance: string;
        sql: string;
      };

      assert.equal(body.performance, "small");
      assert.match(body.sql, /FROM dex\.trades/);
      assert.match(body.sql, /FROM cex\.flows/);
      assert.match(body.sql, /blockchain = 'ethereum'/);
      assert.match(body.sql, /upper\(token_bought_symbol\) = 'ENA'/);
      assert.match(body.sql, /upper\(token_symbol\) = 'ENA'/);
      assert.match(
        body.sql,
        /lower\(flow_type\) IN \('withdrawal', 'deposit', 'outflow', 'inflow'\)/
      );
      assert.match(body.sql, /date_add\('day', -30, current_timestamp\)/);

      return jsonResponse({
        execution_id: "01KSQL",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSQL/status") {
      return jsonResponse({
        execution_id: "01KSQL",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSQL/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 1000,
              category: "non-stable token accumulation",
              signal: "DEX buy",
              status: "large-flow watchlist",
              token: "ENA",
              trades: 4,
              usd_value: 250000,
              wallet: "0x1111111111111111111111111111111111111111",
              window: "2026-05-01 to 2026-05-23",
            },
            {
              amount: 1200,
              category: "non-stable token accumulation",
              signal: "CEX withdrawal",
              sourceCex: "Bybit",
              status: "candidate smart-money",
              token: "ENA",
              transfers: 2,
              usd_value: 300000,
              wallet: "0x2222222222222222222222222222222222222222",
              window: "2026-05-20 to 2026-05-23",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
        DUNE_SQL_PERFORMANCE: "small",
      },
      async () => {
        const result = await getSmartMoneyDexBuyCandidates({
          chain: "ethereum",
          query: "Find smart-money accumulation for ENA on Ethereum last 30 days",
        });

        assert.match(result.summary ?? "", /DEX and CEX flow SQL/);
        assert.match(result.summary ?? "", /returned 2 row/);
        assert.deepEqual(seenPaths, [
          "/api/v1/sql/execute",
          "/api/v1/execution/01KSQL/status",
          "/api/v1/execution/01KSQL/results",
        ]);
      }
    );
  } finally {
    restore();
  }
});

test("Dune Sui accumulation provider uses Sui-native DEX rows", async () => {
  const seenPaths: string[] = [];
  let executeCount = 0;
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);
    seenPaths.push(parsed.pathname);

    if (parsed.pathname === "/api/v1/sql/execute") {
      assert.equal(init?.method, "POST");
      executeCount += 1;

      const body = JSON.parse(String(init?.body)) as {
        performance: string;
        sql: string;
      };

      assert.equal(body.performance, "small");
      assert.doesNotMatch(body.sql, /FROM dex\.trades/);
      assert.doesNotMatch(body.sql, /FROM cex\.flows/);

      if (executeCount === 1) {
        assert.match(body.sql, /FROM dex_sui\.trades/);
        assert.match(body.sql, /'DEX buy' AS signal/);
        assert.match(body.sql, /'large_flow_watchlist' AS smartMoneyStatus/);

        return jsonResponse({
          execution_id: "01KSUIDEX",
          state: "QUERY_STATE_PENDING",
        });
      }

      assert.equal(executeCount, 2);
      assert.match(body.sql, /FROM tokens_sui\.transfers/);
      assert.match(body.sql, /FROM labels\.addresses/);
      assert.match(body.sql, /block_date/);
      assert.doesNotMatch(body.sql, /model_name/);
      assert.match(body.sql, /tx_digest/);
      assert.doesNotMatch(body.sql, /tx_hash/);
      assert.match(body.sql, /'CEX withdrawal'/);
      assert.match(body.sql, /'CEX deposit'/);

      return jsonResponse({
        execution_id: "01KSUICEX",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (
      parsed.pathname === "/api/v1/execution/01KSUIDEX/status" ||
      parsed.pathname === "/api/v1/execution/01KSUICEX/status"
    ) {
      return jsonResponse({
        execution_id: parsed.pathname.includes("01KSUIDEX")
          ? "01KSUIDEX"
          : "01KSUICEX",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUIDEX/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 42000,
              netUsd: 125000,
              signal: "DEX buy",
              smartMoneyStatus: "large_flow_watchlist",
              tokenCategory: "non-stable token accumulation",
              tokenSymbol: "CETUS",
              trades: 17,
              wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              window: "2026-06-15 to 2026-06-16",
            },
          ],
        },
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEX/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 12500,
              netUsd: 42000,
              signal: "CEX withdrawal",
              smartMoneyStatus: "candidate_smart_money",
              sourceCex: "OKX",
              sourceChain: "Sui",
              sourceTable: "tokens_sui.transfers + labels.addresses",
              tokenSymbol: "CETUS",
              transfers: 3,
              wallet: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
              window: "2026-06-15 to 2026-06-16",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
        DUNE_SQL_PERFORMANCE: "small",
      },
      async () => {
        const result = await getSuiAccumulationFlow({
          chain: "sui",
          query: "Find smart-money accumulation for $CETUS on Sui",
        });
        const data = result.data as {
          result?: { rows?: Array<Record<string, unknown>> };
          target?: { chain?: string; symbol?: string };
        };

        assert.match(result.summary ?? "", /Sui DEX accumulation row/);
        assert.match(result.summary ?? "", /Sui CEX transfer lookup added 1 exchange-flow row/);
        assert.equal(data.target?.chain, "sui");
        assert.equal(data.target?.symbol, "CETUS");
        assert.equal(data.result?.rows?.[0]?.signal, "DEX buy");
        assert.equal(data.result?.rows?.[0]?.smartMoneyStatus, "large_flow_watchlist");
        assert.equal(data.result?.rows?.[1]?.signal, "CEX withdrawal");
        assert.equal(data.result?.rows?.[1]?.smartMoneyStatus, "candidate_smart_money");
        assert.deepEqual(seenPaths, [
          "/api/v1/sql/execute",
          "/api/v1/execution/01KSUIDEX/status",
          "/api/v1/execution/01KSUIDEX/results",
          "/api/v1/sql/execute",
          "/api/v1/execution/01KSUICEX/status",
          "/api/v1/execution/01KSUICEX/results",
        ]);
      }
    );
  } finally {
    restore();
  }
});

test("Dune Sui accumulation provider falls back to CEX address context", async () => {
  let executeCount = 0;
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (parsed.pathname === "/api/v1/sql/execute") {
      executeCount += 1;
      const body = JSON.parse(String(init?.body)) as { sql: string };

      if (executeCount === 1) {
        assert.match(body.sql, /FROM dex_sui\.trades/);

        return jsonResponse({
          execution_id: "01KSUIDEXCTX",
          state: "QUERY_STATE_PENDING",
        });
      }

      if (executeCount === 2) {
        assert.match(body.sql, /FROM tokens_sui\.transfers/);

        return jsonResponse({
          execution_id: "01KSUICEXPRIVATE",
          state: "QUERY_STATE_PENDING",
        });
      }

      assert.equal(executeCount, 3);
      assert.match(body.sql, /FROM cex\.addresses/);
      assert.match(body.sql, /'CEX address label' AS signal/);

      return jsonResponse({
        execution_id: "01KSUICEXADDR",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUIDEXCTX/status") {
      return jsonResponse({
        execution_id: "01KSUIDEXCTX",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXPRIVATE/status") {
      return jsonResponse({
        error: {
          message: "tokens_sui.transfers does not exist or it is private",
          type: "FAILED_TYPE_EXECUTION_FAILED",
        },
        execution_id: "01KSUICEXPRIVATE",
        is_execution_finished: true,
        state: "QUERY_STATE_FAILED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXADDR/status") {
      return jsonResponse({
        execution_id: "01KSUICEXADDR",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUIDEXCTX/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 42000,
              netUsd: 125000,
              signal: "DEX buy",
              smartMoneyStatus: "large_flow_watchlist",
              tokenSymbol: "CETUS",
              trades: 17,
              wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              window: "2026-06-15 to 2026-06-16",
            },
          ],
        },
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXADDR/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              signal: "CEX address label",
              smartMoneyStatus: "excluded_address",
              sourceCex: "Binance",
              sourceChain: "Sui",
              sourceTable: "cex.addresses",
              wallet: "0x5fdfcc18e0791862c107c49ea13a5bcf4965f00ac057f56ea04034ebb5ea45ad",
              walletLabel: "Binance 1",
              window: "current Dune cex.addresses snapshot",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
      },
      async () => {
        const result = await getSuiAccumulationFlow({
          chain: "sui",
          query: "Find smart-money accumulation on Sui",
        });
        const data = result.data as {
          result?: { rows?: Array<Record<string, unknown>> };
          routeDebug?: { cexRoute?: Record<string, unknown> };
        };

        assert.match(result.summary ?? "", /cex\.addresses added 1 exchange-label context row/i);
        assert.equal(data.routeDebug?.cexRoute?.route, "cex.addresses");
        assert.equal(data.routeDebug?.cexRoute?.signalKind, "address-context");
        assert.equal(data.result?.rows?.[1]?.signal, "CEX address label");
        assert.equal(data.result?.rows?.[1]?.smartMoneyStatus, "excluded_address");
      }
    );
  } finally {
    restore();
  }
});

test("Dune Sui accumulation provider uses BlockVision activity before label-only CEX context", async () => {
  let executeCount = 0;
  const cexAddress =
    "0x5fdfcc18e0791862c107c49ea13a5bcf4965f00ac057f56ea04034ebb5ea45ad";
  const counterparty =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (parsed.pathname === "/api/v1/sql/execute") {
      executeCount += 1;
      const body = JSON.parse(String(init?.body)) as { sql: string };

      if (executeCount === 1) {
        assert.match(body.sql, /FROM dex_sui\.trades/);

        return jsonResponse({
          execution_id: "01KSUIDEXBV",
          state: "QUERY_STATE_PENDING",
        });
      }

      if (executeCount === 2) {
        assert.match(body.sql, /FROM tokens_sui\.transfers/);

        return jsonResponse({
          execution_id: "01KSUICEXPRIVATEBV",
          state: "QUERY_STATE_PENDING",
        });
      }

      assert.equal(executeCount, 3);
      assert.match(body.sql, /FROM cex\.addresses/);

      return jsonResponse({
        execution_id: "01KSUICEXADDRBV",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUIDEXBV/status") {
      return jsonResponse({
        execution_id: "01KSUIDEXBV",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXPRIVATEBV/status") {
      return jsonResponse({
        error: {
          message: "tokens_sui.transfers does not exist or it is private",
          type: "FAILED_TYPE_EXECUTION_FAILED",
        },
        execution_id: "01KSUICEXPRIVATEBV",
        is_execution_finished: true,
        state: "QUERY_STATE_FAILED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXADDRBV/status") {
      return jsonResponse({
        execution_id: "01KSUICEXADDRBV",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUIDEXBV/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 42000,
              netUsd: 125000,
              signal: "DEX buy",
              smartMoneyStatus: "large_flow_watchlist",
              tokenSymbol: "CETUS",
              wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              window: "2026-06-15 to 2026-06-16",
            },
          ],
        },
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXADDRBV/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              signal: "CEX address label",
              smartMoneyStatus: "excluded_address",
              sourceCex: "Binance",
              sourceChain: "Sui",
              sourceTable: "cex.addresses",
              wallet: cexAddress,
              walletLabel: "Binance 1",
              window: "current Dune cex.addresses snapshot",
            },
          ],
        },
      });
    }

    if (parsed.pathname === "/v2/sui/account/activities") {
      assert.equal(parsed.searchParams.get("address"), cexAddress);
      assert.equal(parsed.searchParams.get("limit"), "50");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "blockvision-test-key");

      return jsonResponse({
        code: 200,
        message: "OK",
        result: {
          data: [
            {
              coinChanges: [
                {
                  amount: "-12500000000000",
                  coinAddress: "0x2::sui::SUI",
                  decimal: 9,
                  symbol: "CETUS",
                  usdValue: "42000",
                },
              ],
              digest: "A1",
              interactAddresses: [{ address: counterparty, type: "account" }],
              sender: cexAddress,
              status: "success",
              timestampMs: String(Date.now()),
              type: "Send",
            },
          ],
        },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
        SUI_BLOCKVISION_API_KEY: "blockvision-test-key",
        SUI_BLOCKVISION_BASE_URL: "https://api.blockvision.org/v2/sui",
        SUI_BLOCKVISION_ENABLED: "true",
      },
      async () => {
        const result = await getSuiAccumulationFlow({
          chain: "sui",
          query: "Find smart-money accumulation for $CETUS on Sui",
        });
        const data = result.data as {
          result?: { rows?: Array<Record<string, unknown>> };
          routeDebug?: { cexRoute?: Record<string, unknown> };
        };
        const cexRow = data.result?.rows?.[1];

        assert.match(result.summary ?? "", /BlockVision account activity across 1 CEX address/i);
        assert.equal(data.routeDebug?.cexRoute?.route, "blockvision.account/activities");
        assert.equal(data.routeDebug?.cexRoute?.signalKind, "activity-flow");
        assert.equal(cexRow?.wallet, counterparty);
        assert.equal(cexRow?.tokenSymbol, "CETUS");
        assert.equal(cexRow?.signal, "CEX withdrawal");
        assert.equal(cexRow?.amount, 12500);
        assert.equal(cexRow?.netUsd, 42000);
        assert.equal(cexRow?.sourceCex, "Binance");
        assert.equal(
          cexRow?.sourceTable,
          "BlockVision account/activities + Dune cex.addresses"
        );
        assert.equal(cexRow?.smartMoneyStatus, "candidate_smart_money");
      }
    );
  } finally {
    restore();
  }
});

test("Dune Sui accumulation provider uses Sui RPC withdrawal fallback when BlockVision is unavailable", async () => {
  let executeCount = 0;
  const cexAddress =
    "0x5fdfcc18e0791862c107c49ea13a5bcf4965f00ac057f56ea04034ebb5ea45ad";
  const counterparty =
    "0x7ab9a6a7109dcb9cb357a109f32dfcc78a7aa2d6029084eb924d95133fc71cec";
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (parsed.pathname === "/api/v1/sql/execute") {
      executeCount += 1;
      const body = JSON.parse(String(init?.body)) as { sql: string };

      if (executeCount === 1) {
        assert.match(body.sql, /FROM dex_sui\.trades/);

        return jsonResponse({
          execution_id: "01KSUIDEXRPC",
          state: "QUERY_STATE_PENDING",
        });
      }

      if (executeCount === 2) {
        assert.match(body.sql, /FROM tokens_sui\.transfers/);

        return jsonResponse({
          execution_id: "01KSUICEXPRIVATERPC",
          state: "QUERY_STATE_PENDING",
        });
      }

      assert.equal(executeCount, 3);
      assert.match(body.sql, /FROM cex\.addresses/);

      return jsonResponse({
        execution_id: "01KSUICEXADDRRPC",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUIDEXRPC/status") {
      return jsonResponse({
        execution_id: "01KSUIDEXRPC",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXPRIVATERPC/status") {
      return jsonResponse({
        error: {
          message: "tokens_sui.transfers does not exist or it is private",
          type: "FAILED_TYPE_EXECUTION_FAILED",
        },
        execution_id: "01KSUICEXPRIVATERPC",
        is_execution_finished: true,
        state: "QUERY_STATE_FAILED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXADDRRPC/status") {
      return jsonResponse({
        execution_id: "01KSUICEXADDRRPC",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUIDEXRPC/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 42000,
              netUsd: 125000,
              signal: "DEX buy",
              smartMoneyStatus: "large_flow_watchlist",
              tokenSymbol: "CETUS",
              wallet: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              window: "2026-06-15 to 2026-06-16",
            },
          ],
        },
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KSUICEXADDRRPC/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              signal: "CEX address label",
              smartMoneyStatus: "excluded_address",
              sourceCex: "Binance",
              sourceChain: "Sui",
              sourceTable: "cex.addresses",
              wallet: cexAddress,
              walletLabel: "Binance 1",
              window: "current Dune cex.addresses snapshot",
            },
          ],
        },
      });
    }

    if (parsed.pathname === "/v2/sui/account/activities") {
      return jsonResponse(
        {
          code: -32609,
          message: "Your 30 trial requests have been used.",
        },
        { status: 403 }
      );
    }

    if (parsed.hostname === "sui-rpc.test") {
      const body = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };

      if (body.method === "suix_queryTransactionBlocks") {
        return jsonResponse({
          id: 1,
          jsonrpc: "2.0",
          result: {
            data: [
              {
                balanceChanges: [
                  {
                    amount: "-10000000000000",
                    coinType: "0x2::sui::SUI",
                    owner: { AddressOwner: cexAddress },
                  },
                  {
                    amount: "10000000000000",
                    coinType: "0x2::sui::SUI",
                    owner: { AddressOwner: counterparty },
                  },
                ],
                digest: "rpc-digest-1",
                timestampMs: String(Date.now()),
              },
            ],
          },
        });
      }

      assert.equal(body.method, "suix_getCoinMetadata");

      return jsonResponse({
        id: 1,
        jsonrpc: "2.0",
        result: {
          decimals: 9,
          symbol: "SUI",
        },
      });
    }

    if (parsed.pathname === "/api/v3/simple/price") {
      assert.equal(parsed.searchParams.get("ids"), "sui");

      return jsonResponse({
        sui: { usd: 1.25 },
      });
    }

    throw new Error(`Unexpected request: ${url}`);
  });

  try {
    await withEnv(
      {
        COINGECKO_API_KEY: "coingecko-test-key",
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
        SUI_ANALYTICS_RPC_URL: "https://sui-rpc.test",
        SUI_BLOCKVISION_API_KEY: "blockvision-test-key",
        SUI_BLOCKVISION_BASE_URL: "https://api.blockvision.org/v2/sui",
        SUI_BLOCKVISION_ENABLED: "true",
      },
      async () => {
        const result = await getSuiAccumulationFlow({
          chain: "sui",
          query: "Find smart-money accumulation on Sui",
        });
        const data = result.data as {
          result?: { rows?: Array<Record<string, unknown>> };
          routeDebug?: { cexRoute?: Record<string, unknown> };
        };
        const cexRow = data.result?.rows?.[1];

        assert.match(result.summary ?? "", /Sui RPC withdrawal scan across 1 CEX address/i);
        assert.equal(data.routeDebug?.cexRoute?.route, "sui.rpc.transaction_blocks");
        assert.equal(data.routeDebug?.cexRoute?.signalKind, "rpc-flow");
        assert.equal(cexRow?.wallet, counterparty);
        assert.equal(cexRow?.tokenSymbol, "SUI");
        assert.equal(cexRow?.signal, "CEX withdrawal");
        assert.equal(cexRow?.amount, 10000);
        assert.equal(cexRow?.netUsd, 12500);
        assert.equal(
          cexRow?.sourceTable,
          "Sui RPC transaction blocks + Dune cex.addresses"
        );
      }
    );
  } finally {
    restore();
  }
});

test("Dune smart-money provider retries same-chain relaxed SQL before cross-scope fallback", async () => {
  const executedSql: string[] = [];
  const restore = mockFetch((url, init) => {
    const parsed = new URL(url);

    if (parsed.pathname === "/api/v1/sql/execute") {
      const body = JSON.parse(String(init?.body)) as { sql: string };
      executedSql.push(body.sql);

      return jsonResponse({
        execution_id:
          executedSql.length === 1
            ? "01KPRIMARYEMPTY"
            : executedSql.length === 2
              ? "01KRELAXEDROWS"
              : "01KEXTERNALCEX",
        state: "QUERY_STATE_PENDING",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KPRIMARYEMPTY/status") {
      return jsonResponse({
        execution_id: "01KPRIMARYEMPTY",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KPRIMARYEMPTY/results") {
      return jsonResponse({ result: { rows: [] } });
    }

    if (parsed.pathname === "/api/v1/execution/01KRELAXEDROWS/status") {
      return jsonResponse({
        execution_id: "01KRELAXEDROWS",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KRELAXEDROWS/results") {
      return jsonResponse({
        result: {
          rows: [
            {
              amount: 5228973.96,
              category: "non-stable token accumulation",
              signal: "DEX buy",
              smartMoneyStatus: "large_flow_watchlist",
              sourceChain: "mantle",
              sourceTable: "dex.trades",
              status: "large-flow watchlist",
              token: "WMNT",
              trades: 1566,
              usd_value: 3485162.25,
              wallet: "0xbd41474c37a551a6e735cfc59bdd1d2d6071ae0f",
              window: "2026-04-23 to 2026-05-23",
            },
          ],
        },
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KEXTERNALCEX/status") {
      return jsonResponse({
        execution_id: "01KEXTERNALCEX",
        is_execution_finished: true,
        state: "QUERY_STATE_COMPLETED",
      });
    }

    if (parsed.pathname === "/api/v1/execution/01KEXTERNALCEX/results") {
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
    await withEnv(
      {
        DUNE_API_KEY: "dune-test-key",
        DUNE_SQL_POLL_INTERVAL_MS: "1",
      },
      async () => {
        const result = await getSmartMoneyDexBuyCandidates({
          chain: "mantle",
          query: "Find smart-money accumulation on Mantle",
        });
        const data = result.data as {
          result?: { rows?: Array<Record<string, unknown>> };
          routeDebug?: {
            fallbackAttempts?: Array<Record<string, unknown>>;
            preservationCheck?: string;
          };
        };

        assert.equal(data.result?.rows?.[0]?.token, "WMNT");
        assert.equal(data.result?.rows?.[1]?.signal, "CEX withdrawal");
        assert.match(result.summary ?? "", /retried the same chain/i);
        assert.match(result.summary ?? "", /Supplemental Ethereum MNT CEX transfer lookup returned 1 row/i);
        assert.match(executedSql[0] ?? "", /blockchain = 'mantle'/);
        assert.match(executedSql[0] ?? "", /amount_usd >= 10000/);
        assert.match(executedSql[0] ?? "", /date_add\('day', -7, current_timestamp\)/);
        assert.match(executedSql[1] ?? "", /blockchain = 'mantle'/);
        assert.match(executedSql[1] ?? "", /amount_usd >= 1000/);
        assert.match(executedSql[1] ?? "", /date_add\('day', -30, current_timestamp\)/);
        assert.match(executedSql[2] ?? "", /tokens\.transfers/);
        assert.match(executedSql[2] ?? "", /labels\.addresses/);
        assert.match(executedSql[2] ?? "", /blockchain = 'ethereum'/);
        assert.match(
          executedSql[2] ?? "",
          /0x3c3a81e81dc49a522a592e7622a7e711c06bf354/i
        );
        assert.equal(
          data.routeDebug?.fallbackAttempts?.[0]?.route,
          "dune.smart_money_sql.same_chain_relaxed"
        );
        assert.equal(
          data.routeDebug?.fallbackAttempts?.[1]?.route,
          "dune.smart_money_sql.external_cex_transfers"
        );
        assert.match(
          data.routeDebug?.preservationCheck ?? "",
          /external token signal is labeled context/i
        );
      }
    );
  } finally {
    restore();
  }
});
