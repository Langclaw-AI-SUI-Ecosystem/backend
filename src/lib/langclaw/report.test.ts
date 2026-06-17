import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOnChainResearchReport,
  buildWorkflowResearchReport,
  renderResearchReportMarkdown,
} from "./report";
import type {
  DiscoverSignals,
  ProviderError,
  ProviderTraceEntry,
  SourceCard,
} from "./types";
import type { OnChainPlanSummary, OnChainToolResult } from "../onchain-tools/types";

const defaultSignals: DiscoverSignals = {
  combined: {
    providers: ["Surf", "DEX Screener"],
    sourceIds: ["source-1"],
    status: "partial",
    summary: "Combined signal is partial.",
    toolIds: ["pair_liquidity.pair_details"],
  },
  onchain: {
    providers: ["DEX Screener"],
    sourceIds: [],
    status: "success",
    summary: "On-chain signal is usable.",
    toolIds: ["pair_liquidity.pair_details"],
  },
  social: {
    providers: ["Surf"],
    sourceIds: ["source-1"],
    status: "partial",
    summary: "Social signal is partial.",
    toolIds: [],
  },
};

const defaultPlan: OnChainPlanSummary = {
  analysisSource: "prompt",
  chain: "mantle",
  chainId: 5000,
  chainName: "Mantle",
  commands: [],
  domainCount: 14,
  intent: "trading-signal",
  nativeSymbol: "MNT",
  productChain: "sui-testnet",
  productChainId: 1,
  productChainName: "Sui Testnet",
  query: "Detect liquidity anomalies on Mantle DEX pairs",
  registryCommandCount: 83,
};

test("on-chain liquidity report ranks pairs and computes turnover from DEX Screener data", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: defaultPlan,
    recommendation: "Monitor the top pool for LP movement.",
    tools: [
      {
        commandId: "pair_liquidity.pair_details",
        data: {
          pairs: [
            {
              baseToken: { symbol: "BSB" },
              liquidity: { usd: 843200 },
              pairAddress: "0xdc16",
              priceChange: { h24: 21.6 },
              quoteToken: { symbol: "USDT0" },
              txns: { h24: { buys: 3440, sells: 3440 } },
              volume: { h24: 1870000 },
            },
            {
              baseToken: { symbol: "BILL" },
              liquidity: { usd: 363900 },
              pairAddress: "0x509b",
              priceChange: { h24: 21.3 },
              quoteToken: { symbol: "USDT0" },
              txns: { h24: { buys: 1100, sells: 1115 } },
              volume: { h24: 98100 },
            },
          ],
        },
        domain: "pair_liquidity",
        latencyMs: 12,
        provider: "dexscreener",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched pair-level liquidity data.",
        title: "Pair details",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "liquidity-anomaly");
  assert.equal(report.entities[0]?.label, "BSB / USDT0");
  assert.equal(report.entities[0]?.severity, "high");
  assert.equal(report.entities[0]?.metrics.turnover24h, 2.22);
  assert.ok(report.tables.some((table) => table.id === "anomaly-table"));

  const markdown = renderResearchReportMarkdown(report);

  assert.match(markdown, /Anomaly Table/i);
  assert.match(markdown, /BSB \/ USDT0/i);
});

test("smart-money report without direct rows stays directional and friendly", () => {
  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      commands: [
        {
          commandId: "smart_money.nansen_smart_money_netflow",
          domain: "smart_money",
          provider: "nansen",
          reason: "Read smart-money flow.",
          title: "Smart money netflow",
        },
      ],
      intent: "smart-money",
      query: "Find smart-money accumulation on Mantle",
    },
    recommendation:
      "Keep this as coverage-limited smart-money research on Mantle. Standard follow-up checks were attempted where row data existed; unavailable checks are listed in the report.",
    tools: [
      {
        attemptedProviders: ["nansen", "dune"],
        commandId: "smart_money.nansen_smart_money_netflow",
        domain: "smart_money",
        error: "Dune did not return row-level smart-money rows.",
        fallbackReason:
          "Nansen did not return row-level smart-money rows. | Dune did not return row-level smart-money rows.",
        latencyMs: 20,
        provider: "nansen",
        scope: "legacy-fallback",
        status: "failed",
        summary: "Dune did not return row-level smart-money rows.",
        title: "Smart money netflow",
      },
      {
        commandId: "smart_money.smart_money_signal_synthesis",
        data: {
          completedTools: 0,
          failedTools: 1,
          summaries: ["Dune did not return row-level smart-money rows."],
        },
        domain: "smart_money",
        latencyMs: 1,
        provider: "local",
        status: "success",
        summary:
          "Synthesized 0 successful tool results and 1 failed tool results into an analysis-only signal.",
        title: "Smart money signal synthesis",
      },
    ] satisfies OnChainToolResult[],
  });

  const markdown = renderResearchReportMarkdown(report);

  assert.equal(report.kind, "smart-money");
  assert.equal(report.title, "Mantle Smart-Money Accumulation Watch");
  assert.equal(report.entities.length, 0);
  assert.equal(report.tables.length, 0);
  assert.match(report.executiveSummary, /Smart-money signal is still weak/i);
  assert.match(report.bottomLine, /Confidence is low/i);
  assert.deepEqual(
    report.sections.map((section) => section.title),
    [
	      "Read",
	      "Evidence",
	      "Confirmed smart money",
	      "Candidate smart money",
	      "Large-flow watchlist",
	      "Excluded addresses",
	      "Limits",
	      "Data source diagnostics",
	      "Follow-up checks performed",
	      "Checks unavailable",
	      "Conclusion",
      "What would improve confidence",
    ]
  );
  assert.match(markdown, /wallet-flow rows/i);
  assert.match(markdown, /Direct wallet-flow rows were unavailable/i);
  assert.match(markdown, /No wallet candidates are ranked/i);
  assert.doesNotMatch(markdown, /Rerun with a specific/i);
  assert.doesNotMatch(markdown, /Belum ada bukti akumulasi terverifikasi/i);
});

test("smart-money report with direct rows uses candidate sections", () => {
  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      commands: [
        {
          commandId: "smart_money.dune_query_results",
          domain: "smart_money",
          provider: "dune",
          reason: "Read configured wallet-flow query.",
          title: "Dune wallet-flow rows",
        },
      ],
      intent: "smart-money",
      query: "Find smart-money accumulation on Mantle",
    },
    recommendation: "Monitor repeat buys and CEX withdrawals.",
    tools: [
      {
        commandId: "smart_money.dune_query_results",
        data: {
          rows: [
            {
              wallet: "0xbdb3...47b6",
              signal: "CEX withdrawal",
              netMnt: 177700,
              netUsd: 120900,
              transfers: 3,
              window: "2026-05-21",
            },
            {
              wallet: "0xb33b...a52e",
              signal: "DEX buy",
              netMnt: 179400,
              netUsd: 119400,
              trades: 134,
              window: "2026-05-20 to 2026-05-21",
            },
          ],
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "dune",
        scope: "legacy-fallback",
        status: "success",
        summary: "Dune returned wallet-flow rows.",
        title: "Dune wallet-flow rows",
      },
    ] satisfies OnChainToolResult[],
  });

  const markdown = renderResearchReportMarkdown(report);

  assert.equal(report.kind, "smart-money");
  assert.equal(report.title, "Mantle Smart-Money Accumulation Watch");
  const candidateTable = report.tables.find((table) => table.id === "smart-money-table");
  const dexTable = report.tables.find((table) => table.id === "dex-accumulation-table");
  const cexTable = report.tables.find((table) => table.id === "cex-withdrawal-table");

  assert.equal(report.entities[0]?.label, "0xbdb3...47b6");
  assert.equal(dexTable?.title, "DEX Accumulation");
  assert.equal(cexTable?.title, "CEX Withdrawal Candidates");
  assert.equal(candidateTable?.title, "Candidate Smart-Money Wallets");
  assert.deepEqual(cexTable?.columns, [
    "Rank",
    "Wallet",
    "Token",
    "Flow type",
    "Amount",
    "USD value",
    "Category",
    "Time window",
  ]);
  assert.deepEqual(candidateTable?.columns, [
	    "Wallet",
	    "Token",
	    "Signal",
	    "Amount",
	    "USD value",
	    "Trades",
	    "Window",
	    "Category",
	    "Status",
	  ]);
  assert.match(report.executiveSummary, /candidate smart-money flow/i);
  assert.match(markdown, /Best candidate: 0xbdb3\.\.\.47b6/i);
  assert.match(markdown, /CEX Withdrawal Candidates/i);
  assert.match(markdown, /Candidate Smart-Money Wallets/i);
  assert.match(markdown, /Coverage gap\./i);
  assert.match(markdown, /Sample window\..*2026-05-21/i);
  assert.match(markdown, /Smart-money labeling gap\./i);
  assert.doesNotMatch(markdown, /confirmed_smart_money|large_flow_watchlist|data_source_diagnostics/i);
  assert.doesNotMatch(markdown, /No wallet candidates are ranked/i);
});

test("smart-money report replaces generic Surf limits with contextual run limits", () => {
  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "smart-money",
      query: "Find smart-money accumulation on Mantle",
    },
    recommendation: "Monitor repeat buys and CEX withdrawals.",
    tools: [
      {
        commandId: "smart_money.surf_research",
        data: {
          rows: [
            {
              label: "0xb33b...a52e",
              signal: "DEX buy",
              smartMoneyStatus: "large_flow_watchlist",
              sourceChain: "Ethereum",
              sourceTable: "agent.ethereum_dex_trades",
              tokenAddress: "0x3c3a81e81dc49a522a592e762a7e711c06bf354",
              tokenAddressChainName: "Ethereum",
              tokenSymbol: "MNT",
              wallet: "0xb33b...a52e",
              walletLabel: "unavailable",
              walletNetWorth: "unavailable",
              walletType: "unknown",
              window: "2026-05-20 to 2026-05-21",
            },
          ],
          sections: [
            {
              title: "Read",
              markdown: "Surf read.",
            },
            {
              title: "Limits",
              markdown: "Generic provider limits that should be replaced.",
            },
            {
              title: "Conclusion",
              markdown: "Surf conclusion.",
            },
          ],
          target: {
            chainName: "Ethereum",
            externalTokenSignal: true,
            mode: "external-token-signal",
            requestedChainName: "Mantle",
            symbol: "MNT",
            tokenAddress: "0x3c3a81e81dc49a522a592e762a7e711c06bf354",
            tokenAddressChainName: "Ethereum",
          },
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "surf",
        scope: "legacy-fallback",
        status: "success",
        summary: "Surf returned wallet-flow rows.",
        title: "Surf smart-money rows",
      },
    ] satisfies OnChainToolResult[],
  });
  const limits = report.sections.find((section) => section.title === "Limits");

  assert.ok(limits);
  assert.doesNotMatch(limits.markdown, /Generic provider limits/i);
  assert.match(limits.markdown, /Mantle-native holder and transfer coverage was not confirmed/i);
  assert.match(limits.markdown, /External token signal/i);
  assert.match(limits.markdown, /not Mantle chain-level activity/i);
  assert.match(limits.markdown, /agent\.ethereum_dex_trades/i);
  assert.match(limits.markdown, /2026-05-20 to 2026-05-21/i);
  assert.match(limits.markdown, /large-flow watchlist/i);
});

test("smart-money report keeps CEX deposits out of accumulation candidates", () => {
  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "smart-money",
      query: "Find smart-money accumulation on Ethereum",
    },
    recommendation: "Monitor exchange pressure.",
    tools: [
      {
        commandId: "smart_money.dune_query_results",
        data: {
          result: {
            rows: [
              {
                amount: 1000,
                signal: "CEX deposit",
                smartMoneyStatus: "sell_pressure_watchlist",
                sourceCex: "Binance",
                status: "sell-pressure watchlist",
                token: "ENA",
                transfers: 2,
                usd_value: 400000,
                wallet: "0x1111...2222",
                window: "2026-05-20 to 2026-05-21",
              },
            ],
          },
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "dune",
        scope: "legacy-fallback",
        status: "success",
        summary: "Dune returned CEX deposit rows.",
        title: "Dune CEX rows",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.entities[0]?.category, "sell-pressure-watchlist");
  assert.ok(report.tables.some((table) => table.id === "cex-deposit-table"));
  assert.ok(!report.tables.some((table) => table.id === "smart-money-table"));
});

test("smart-money report separates Sui BlockVision holder snapshots from candidate table", () => {
  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-06-16T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      chain: "sui",
      chainId: 784,
      chainName: "Sui",
      intent: "smart-money",
      nativeSymbol: "SUI",
      query: "Find smart-money accumulation on Sui",
    },
    recommendation: "Confirm holder concentration with trade-flow and balance-delta checks.",
    tools: [
      {
        commandId: "smart_money.blockvision_coin_holders",
        data: {
          rows: [
            {
              account: "0x111100000000000000000000000000000000000000000000000000000000aaaa",
              balance: "123456",
              dataSourceDiagnostic:
                "BlockVision holder snapshot. It provides holder labels, balance, and supply share, not DEX trade flow fields.",
              holderSnapshot: "true",
              percentageOfSupply: "12.50%",
              rank: 1,
              signal: "Labeled holder",
              smartMoneyStatus: "excluded_address",
              sourceChain: "Sui",
              sourceTable: "BlockVision coin/holders",
              tokenSymbol: "CETUS",
              wallet: "Kucoin",
              walletLabel: "Kucoin",
              window: "current holder snapshot",
            },
          ],
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "blockvision",
        status: "success",
        summary: "BlockVision returned holder rows.",
        title: "BlockVision Sui coin holders",
      },
      {
        commandId: "smart_money.sui_dune_accumulation",
        data: {
          rows: [
            {
              amount: 6438625.53,
              netUsd: 6436816.89,
              signal: "DEX buy",
              smartMoneyStatus: "large_flow_watchlist",
              sourceChain: "Sui",
              sourceTable: "dex_sui.trades",
              tokenSymbol: "USDC",
              trades: 87,
              wallet: "0xd8d9cc0b82f669161427f0cffbbe17066a8aa277381b0b3b6767c6056cb07b87",
              walletLabel: "unavailable",
              window: "2026-06-15 to 2026-06-16",
            },
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
              wallet: "0xbbbb00000000000000000000000000000000000000000000000000000000cccc",
              walletLabel: "unavailable",
              window: "2026-06-15 to 2026-06-16",
            },
            {
              signal: "CEX address label",
              smartMoneyStatus: "excluded_address",
              sourceCex: "Binance",
              sourceChain: "Sui",
              sourceTable: "cex.addresses",
              tokenCategory: "CEX address context",
              wallet: "0x5fdfcc18e0791862c107c49ea13a5bcf4965f00ac057f56ea04034ebb5ea45ad",
              walletLabel: "Binance 1",
              window: "current Dune cex.addresses snapshot",
            },
          ],
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "dune",
        status: "success",
        summary: "Dune returned Sui DEX accumulation rows.",
        title: "Dune Sui accumulation rows",
      },
    ] satisfies OnChainToolResult[],
  });

  const holderTable = report.tables.find(
    (table) => table.id === "sui-holder-snapshot-table"
  );
  const candidateTable = report.tables.find(
    (table) => table.id === "smart-money-table"
  );
  const dexTable = report.tables.find((table) => table.id === "dex-accumulation-table");
  const cexTable = report.tables.find((table) => table.id === "cex-withdrawal-table");
  const cexContextTable = report.tables.find(
    (table) => table.id === "cex-address-context-table"
  );

  assert.equal(holderTable?.title, "Sui Holder Snapshot");
  assert.equal(holderTable?.rows[0]?.["Wallet/Entity"], "Kucoin");
  assert.equal(holderTable?.rows[0]?.Token, "CETUS");
  assert.equal(holderTable?.rows[0]?.Balance, "123,456");
  assert.equal(holderTable?.rows[0]?.["Supply %"], "12.50%");
  assert.equal(holderTable?.rows[0]?.Status, "excluded address");
  assert.equal(dexTable?.rows[0]?.Wallet, "0xd8d9cc0b82f669161427f0cffbbe17066a8aa277381b0b3b6767c6056cb07b87");
  assert.equal(cexTable?.title, "CEX Withdrawal Candidates");
  assert.equal(cexTable?.rows[0]?.["Flow type"], "CEX withdrawal from OKX");
  assert.equal(cexContextTable?.title, "Sui CEX Candidate Context");
  assert.equal(cexContextTable?.rows[0]?.["Flow type"], "CEX address label (Binance)");
  assert.equal(cexContextTable?.rows[0]?.Token, "Not available");
  assert.equal(cexContextTable?.rows[0]?.Amount, "Not available");
  assert.equal(cexContextTable?.rows[0]?.["USD value"], "Not available");
  assert.ok(
    candidateTable?.rows.some(
      (row) =>
        row.Wallet === "0xbbbb00000000000000000000000000000000000000000000000000000000cccc" &&
        row.Signal === "CEX withdrawal"
    )
  );
  assert.ok(!candidateTable?.rows.some((row) => row.Wallet === "Kucoin"));
});

test("smart-money report keeps Sui CEX context when live command rows exceed old cap", () => {
  const holderRows = Array.from({ length: 15 }, (_, index) => ({
    account: `0xholder${String(index).padStart(2, "0")}`,
    balance: String(100000 + index),
    dataSourceDiagnostic: "BlockVision holder snapshot.",
    holderSnapshot: "true",
    percentageOfSupply: `${index + 1}%`,
    rank: index + 1,
    signal: "Labeled holder",
    smartMoneyStatus: "excluded_address",
    sourceChain: "Sui",
    sourceTable: "BlockVision coin/holders",
    tokenSymbol: "CETUS",
    wallet: `Holder ${index + 1}`,
    walletLabel: `Holder ${index + 1}`,
    window: "current holder snapshot",
  }));
  const dexRows = Array.from({ length: 25 }, (_, index) => ({
    amount: 100000 + index,
    netUsd: 100000 + index,
    signal: "DEX buy",
    smartMoneyStatus: "large_flow_watchlist",
    sourceChain: "Sui",
    sourceTable: "dex_sui.trades",
    tokenSymbol: "USDC",
    trades: 10 + index,
    wallet: `0xdex${String(index).padStart(61, "0")}`,
    walletLabel: "unavailable",
    window: "2026-06-10 to 2026-06-16",
  }));

  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-06-16T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      chain: "sui",
      chainId: 784,
      chainName: "Sui",
      intent: "smart-money",
      nativeSymbol: "SUI",
      query: "Find smart-money accumulation on Sui",
    },
    recommendation: "Confirm CEX context separately from accumulation candidates.",
    tools: [
      {
        commandId: "smart_money.blockvision_coin_holders",
        data: { rows: holderRows },
        domain: "smart_money",
        latencyMs: 20,
        provider: "blockvision",
        status: "success",
        summary: "BlockVision returned holder rows.",
        title: "BlockVision Sui coin holders",
      },
      {
        commandId: "dune.sui_accumulation_flow",
        data: {
          result: {
            rows: [
              ...dexRows,
              {
                signal: "CEX address label",
                smartMoneyStatus: "excluded_address",
                sourceCex: "Binance",
                sourceChain: "Sui",
                sourceTable: "cex.addresses",
                tokenCategory: "CEX address context",
                wallet: "0x5fdfcc18e0791862c107c49ea13a5bcf4965f00ac057f56ea04034ebb5ea45ad",
                walletLabel: "Binance 1",
                window: "current Dune cex.addresses snapshot",
              },
            ],
          },
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "dune",
        status: "success",
        summary: "Dune returned Sui DEX accumulation and CEX address context rows.",
        title: "Dune Sui accumulation rows",
      },
    ] satisfies OnChainToolResult[],
  });
  const cexContextTable = report.tables.find(
    (table) => table.id === "cex-address-context-table"
  );

  assert.equal(cexContextTable?.title, "Sui CEX Candidate Context");
  assert.equal(cexContextTable?.rows[0]?.["Flow type"], "CEX address label (Binance)");
  assert.ok(report.tables.some((table) => table.id === "dex-accumulation-table"));
  assert.ok(report.tables.some((table) => table.id === "sui-holder-snapshot-table"));
});

test("smart-money report ignores non-wallet rows instead of rendering not-available tables", () => {
  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "smart-money",
      query: "Find smart-money accumulation on Ethereum",
    },
    recommendation: "Keep this directional until row-level wallet data is available.",
    tools: [
      {
        commandId: "smart_money.surf_research",
        data: {
          rows: [
            {
              confidence: "low",
              label: "Surf smart-money ability research",
              note: "Narrative-only object without wallet-flow fields.",
              title: "Surf smart-money ability research",
            },
            {
              markdown: "This is a section-like row, not a wallet row.",
              title: "Limits",
            },
          ],
          summary: "Surf returned narrative smart-money context.",
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "surf",
        scope: "legacy-fallback",
        status: "success",
        summary: "Surf returned narrative smart-money context.",
        title: "Surf smart-money ability research",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "smart-money");
  assert.equal(report.entities.length, 0);
  assert.equal(report.tables.length, 0);
  assert.match(report.executiveSummary, /Smart-money signal is still weak/i);
});

test("smart-money report maps aggregate netflow rows without blank candidate columns", () => {
  const report = buildOnChainResearchReport({
    caveat: "Analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "smart-money",
      query: "Find smart-money accumulation on Mantle",
    },
    recommendation: "Monitor repeat flow.",
    tools: [
      {
        commandId: "smart_money.dune_query_results",
        data: {
          result: {
            rows: [
              {
                address: "0x2ca9000000000000000000000000000000003a4c",
                net_flow_7d_usd: 250000,
                symbol: "MNT",
              },
            ],
          },
        },
        domain: "smart_money",
        latencyMs: 20,
        provider: "dune",
        scope: "legacy-fallback",
        status: "success",
        summary: "Dune returned aggregate netflow rows.",
        title: "Dune wallet-flow rows",
      },
    ] satisfies OnChainToolResult[],
  });
  const row = report.tables[0]?.rows[0];

  assert.equal(report.entities.length, 1);
  assert.equal(row?.Wallet, "0x2ca9000000000000000000000000000000003a4c");
  assert.equal(row?.Token, "MNT");
  assert.equal(row?.Signal, "Net flow");
  assert.equal(row?.["USD value"], "250,000");
  assert.notEqual(row?.Status, "Not available");
});

test("liquidity report ranks chain-filtered DEX Screener search rows despite incidental token discovery commands", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      chain: "celo",
      chainId: 42220,
      chainName: "Celo",
      commands: [
        {
          commandId: "pair_liquidity.geckoterminal_network_trending_pools",
          domain: "pair_liquidity",
          provider: "geckoterminal",
          reason: "Fetch trending pools.",
          title: "GeckoTerminal trending pools",
        },
        {
          commandId: "pair_liquidity.liquidity_pair_search",
          domain: "pair_liquidity",
          provider: "dexscreener",
          reason: "Search Celo pairs.",
          title: "Liquidity pair search",
        },
        {
          commandId: "token_discovery.latest_boosts",
          domain: "token_discovery",
          provider: "dexscreener",
          reason: "Read attention proxy.",
          title: "Latest token boosts",
        },
      ],
      intent: "trading-signal",
      query: "Celo",
      rawQuery: "Detect liquidity anomalies on Celo DEX pairs",
    },
    recommendation: "Confirm the top pair before escalating.",
    tools: [
      {
        commandId: "pair_liquidity.geckoterminal_network_trending_pools",
        domain: "pair_liquidity",
        error: "401 Unauthorized",
        latencyMs: 14,
        provider: "geckoterminal",
        scope: "legacy-default",
        status: "failed",
        summary: "401 Unauthorized",
        title: "GeckoTerminal trending pools",
      },
      {
        commandId: "pair_liquidity.liquidity_pair_search",
        data: {
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
        },
        domain: "pair_liquidity",
        latencyMs: 12,
        provider: "dexscreener",
        scope: "legacy-default",
        status: "success",
        summary: "Searched DEX pairs for Celo.",
        title: "Liquidity pair search",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "liquidity-anomaly");
  assert.equal(report.entities[0]?.label, "CELO / USDm");
  assert.equal(report.entities[0]?.metrics.pairAddress, "0x2d70cBAbf4d8e61d5317b62cBe912935FD94e0FE");
  assert.equal(report.entities[0]?.metrics.turnover24h, 6.27);
  assert.equal(report.tables[0]?.id, "anomaly-table");
  assert.match(report.executiveSummary, /ranked pair shortlist from partial coverage/i);
  assert.ok(
    !report.entities.some((entity) => String(entity.metrics.pairAddress).includes("0000000000000001"))
  );
});

test("liquidity report parses GeckoTerminal network pool rows", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      chain: "celo",
      chainId: 42220,
      chainName: "Celo",
      commands: [
        {
          commandId: "pair_liquidity.geckoterminal_network_trending_pools",
          domain: "pair_liquidity",
          provider: "geckoterminal",
          reason: "Fetch trending pools.",
          title: "GeckoTerminal trending pools",
        },
      ],
      intent: "trading-signal",
      query: "Celo",
      rawQuery: "Detect liquidity anomalies on Celo DEX pairs",
    },
    recommendation: "Confirm the top pair before escalating.",
    tools: [
      {
        commandId: "pair_liquidity.geckoterminal_network_trending_pools",
        data: {
          data: [
            {
              attributes: {
                address: "0xpool",
                name: "MOO / CELO",
                price_change_percentage: { h24: "14.2" },
                reserve_in_usd: "42000",
                transactions: {
                  h24: {
                    buys: 240,
                    sells: 310,
                  },
                },
                volume_usd: {
                  h24: "84000",
                },
              },
              id: "celo_0xpool",
            },
          ],
        },
        domain: "pair_liquidity",
        latencyMs: 12,
        provider: "geckoterminal",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched GeckoTerminal trending pools.",
        title: "GeckoTerminal trending pools",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "liquidity-anomaly");
  assert.equal(report.entities[0]?.label, "MOO / CELO");
  assert.equal(report.entities[0]?.metrics.reserveUsd, 42000);
  assert.equal(report.entities[0]?.metrics.volume24hUsd, 84000);
  assert.equal(report.entities[0]?.metrics.priceChange24h, 14.2);
  assert.equal(report.entities[0]?.metrics.txns24h, 550);
  assert.equal(report.tables[0]?.id, "anomaly-table");
});

test("smart-money report stays narrative-first when only local synthesis succeeds", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "smart-money",
      query: "Analyze smart-money accumulation for MNT on Mantle",
    },
    recommendation: "Confirm holder flow with a second source.",
    tools: [
      {
        attemptedProviders: ["nansen", "dune"],
        commandId: "smart_money.nansen_smart_money_netflow",
        domain: "smart_money",
        error: "422 Unknown field",
        fallbackReason: "nansen: 422 Unknown field | dune: 400 query id missing",
        latencyMs: 10,
        provider: "nansen",
        scope: "legacy-fallback",
        status: "failed",
        summary: "422 Unknown field",
        title: "Smart money netflow",
      },
      {
        attemptedProviders: ["local"],
        commandId: "smart_money.smart_money_signal_synthesis",
        data: {
          completedTools: 0,
          failedTools: 1,
        },
        domain: "smart_money",
        latencyMs: 1,
        provider: "local",
        scope: "legacy-default",
        status: "success",
        summary: "Synthesized 0 successful tool results and 1 failed tool results into an analysis-only signal.",
        title: "Smart money signal synthesis",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "smart-money");
  assert.equal(report.tables.length, 0);
  assert.equal(report.entities.length, 0);
  assert.match(report.sections.map((section) => section.markdown).join("\n"), /analysis-only/i);
});

test("workflow report omits fabricated quantitative tables for mixed research", () => {
  const sources: SourceCard[] = [
    {
      excerpt: "Mantle AI agents are gaining traction on social feeds.",
      id: "source-1",
      provider: "Surf",
      title: "Mantle AI context",
      type: "docs_page",
      url: "https://surf.test/mantle-ai",
    },
    {
      excerpt: "Builders are discussing Mantle AI projects.",
      id: "source-2",
      provider: "X",
      title: "Mantle X thread",
      type: "x_post",
      url: "https://x.com/example/status/1",
    },
  ];
  const errors: ProviderError[] = [
    {
      message: "402 Payment Required",
      provider: "Surf",
    },
  ];
  const providerTrace: ProviderTraceEntry[] = [
    {
      message: "402 Payment Required",
      provider: "Surf",
      scope: "sui-premium",
      status: "failed",
    },
  ];

  const report = buildWorkflowResearchReport({
    errors,
    generatedAt: "2026-05-23T04:48:00.000Z",
    providerTrace,
    signals: {
      ...defaultSignals,
      combined: {
        ...defaultSignals.combined,
        status: "partial",
      },
      onchain: {
        ...defaultSignals.onchain,
        status: "failed",
        summary: "On-chain evidence was incomplete.",
      },
    },
    sources,
    topic: "Mantle AI agent market narrative",
  });

  assert.equal(report.kind, "mixed-research");
  assert.equal(report.tables.length, 0);
  assert.equal(report.entities.length, 0);
  assert.match(report.executiveSummary, /Mantle AI agent market narrative/i);
  assert.match(report.caveats.join(" "), /Surf failed/i);
});

test("workflow report caveats do not duplicate combined social partial text", () => {
  const socialPartialCaveat =
    "Social evidence is partial because Elfa failed while other providers still returned source cards.";

  const report = buildWorkflowResearchReport({
    errors: [
      {
        message: "The operation was aborted due to timeout",
        provider: "Elfa",
      },
    ],
    generatedAt: "2026-05-23T04:48:00.000Z",
    signals: {
      combined: {
        providers: ["Surf", "Elfa"],
        sourceIds: ["surf-1"],
        status: "partial",
        summary: "Combined signal is partial.",
        toolIds: [],
        caveat: socialPartialCaveat,
      },
      onchain: {
        providers: [],
        sourceIds: [],
        status: "skipped",
        summary: "On-chain skipped.",
        toolIds: [],
      },
      social: {
        providers: ["Surf"],
        sourceIds: ["surf-1"],
        status: "partial",
        summary: "Social signal is partial.",
        toolIds: [],
        caveat: socialPartialCaveat,
      },
    },
    sources: [
      {
        excerpt: "Mantle market signal",
        id: "surf-1",
        provider: "Surf",
        title: "Surf source",
        type: "docs_page",
        url: "https://surf.test/mantle",
      },
    ],
    topic: "Mantle market narrative",
  });

  const matches = report.caveats.filter((caveat) => caveat === socialPartialCaveat);

  assert.equal(matches.length, 1);
});

test("defi yield report aggregates Mantle protocol TVL and yield rows into a ranked protocol shortlist", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "defi",
      query: "Rank Mantle protocols by TVL and yield momentum",
    },
    recommendation: "Confirm protocol risk before escalating the shortlist.",
    tools: [
      {
        commandId: "defi_tvl.defillama_protocols",
        data: {
          data: [
            {
              chainTvls: {
                Mantle: {
                  tvl: 1200000,
                },
              },
              change_1d: 11,
              change_7d: 40,
              chains: ["Mantle", "Ethereum"],
              id: "agni-finance",
              name: "Agni Finance",
            },
            {
              chainTvls: {
                Mantle: {
                  tvl: 800000,
                },
              },
              change_1d: -2,
              change_7d: 15,
              chains: ["Mantle"],
              id: "methlab",
              name: "Methlab",
            },
            {
              chainTvls: {
                Base: {
                  tvl: 999999999,
                },
              },
              change_1d: 90,
              change_7d: 140,
              chains: ["Base"],
              id: "aerodrome",
              name: "Aerodrome",
            },
          ],
        },
        domain: "defi_tvl",
        latencyMs: 12,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched DeFiLlama protocol TVL list.",
        title: "DeFi protocols TVL",
      },
      {
        commandId: "yield_pools.yield_pool_list",
        data: {
          data: [
            {
              apy: 12,
              apyPct1D: 4,
              apyPct7D: 12,
              chain: "Mantle",
              pool: "agni-usdt0",
              project: "agni-finance",
              symbol: "USDT0",
              tvlUsd: 300000,
            },
            {
              apy: 9,
              apyPct1D: 2,
              apyPct7D: 8,
              chain: "Mantle",
              pool: "agni-mnt",
              project: "agni-finance",
              symbol: "MNT",
              tvlUsd: 200000,
            },
            {
              apy: 15,
              apyPct1D: 1,
              apyPct7D: 3,
              chain: "Mantle",
              pool: "methlab-cmeth",
              project: "methlab",
              symbol: "cmETH",
              tvlUsd: 150000,
            },
            {
              apy: 30,
              apyPct1D: 21,
              apyPct7D: 70,
              chain: "Base",
              pool: "base-noise",
              project: "aerodrome",
              symbol: "USDC",
              tvlUsd: 9000000,
            },
          ],
        },
        domain: "yield_pools",
        latencyMs: 8,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched 4 yield pools.",
        title: "Yield pool list",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "defi-yield");
  assert.equal(report.entities[0]?.label, "Agni Finance");
  assert.equal(report.entities[0]?.metrics.tvlUsd, 1200000);
  assert.equal(report.entities[0]?.metrics.bestApy, 12);
  assert.equal(report.entities[0]?.metrics.poolCount, 2);
  assert.equal(report.entities[0]?.metrics.coverage, "composite");
  assert.equal(report.tables[0]?.id, "yield-table");
  assert.deepEqual(report.tables[0]?.columns, [
    "rank",
    "protocol",
    "score",
    "tvlUsd",
    "bestApy",
    "momentumScore",
    "poolCount",
    "coverage",
  ]);
  assert.ok(
    !report.entities.some((entity) => entity.label.toLowerCase().includes("aerodrome"))
  );
});

test("defi yield report reads numeric Mantle chain TVL from DeFiLlama protocol rows", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      commands: [
        {
          commandId: "defi_tvl.defillama_protocols",
          domain: "defi_tvl",
          provider: "defillama",
          reason: "Fetch protocol TVL.",
          title: "DeFi protocols TVL",
        },
        {
          commandId: "yield_pools.yield_pool_list",
          domain: "yield_pools",
          provider: "defillama",
          reason: "Fetch yield pools.",
          title: "Yield pool list",
        },
      ],
      intent: "defi",
      query: "by",
      rawQuery: "Rank Mantle protocols by TVL and yield momentum",
    },
    recommendation: "Confirm protocol risk before escalating the shortlist.",
    tools: [
      {
        commandId: "defi_tvl.defillama_protocols",
        data: [
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
        ],
        domain: "defi_tvl",
        latencyMs: 12,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched DeFiLlama protocol TVL list.",
        title: "DeFi protocols TVL",
      },
      {
        commandId: "yield_pools.yield_pool_list",
        data: {
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
          ],
        },
        domain: "yield_pools",
        latencyMs: 8,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched 1 yield pool.",
        title: "Yield pool list",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "defi-yield");
  assert.equal(report.entities[0]?.label, "Aave V3");
  assert.equal(report.entities[0]?.metrics.tvlUsd, 136579045.42);
  assert.equal(report.entities[0]?.metrics.bestApy, 5.53);
  assert.equal(report.tables[0]?.id, "yield-table");
});

test("defi yield report keeps a ranked shortlist when momentum fields are missing", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "defi",
      query: "Rank Mantle protocols by TVL and yield momentum",
    },
    recommendation: "Confirm protocol risk before escalating the shortlist.",
    tools: [
      {
        commandId: "defi_tvl.defillama_protocols",
        data: {
          data: [
            {
              chainTvls: {
                Mantle: {
                  tvl: 650000,
                },
              },
              chains: ["Mantle"],
              id: "fusionx",
              name: "FusionX",
            },
          ],
        },
        domain: "defi_tvl",
        latencyMs: 12,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched DeFiLlama protocol TVL list.",
        title: "DeFi protocols TVL",
      },
      {
        commandId: "yield_pools.yield_pool_list",
        data: {
          data: [
            {
              apy: 7,
              chain: "Mantle",
              pool: "fusionx-usdt0",
              project: "fusionx",
              symbol: "USDT0",
              tvlUsd: 200000,
            },
          ],
        },
        domain: "yield_pools",
        latencyMs: 8,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched 1 yield pool.",
        title: "Yield pool list",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.entities.length, 1);
  assert.match(report.executiveSummary, /ranked shortlist from partial coverage/i);
  assert.match(report.sections.map((section) => section.markdown).join("\n"), /partial coverage/i);
  assert.equal(report.entities[0]?.metrics.coverage, "tvl+apy");
});

test("workflow report preserves ranked DeFi entities from on-chain report", () => {
  const onChainReport = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      commands: [
        {
          commandId: "defi_tvl.defillama_protocols",
          domain: "defi_tvl",
          provider: "defillama",
          reason: "Fetch protocol TVL.",
          title: "DeFi protocols TVL",
        },
        {
          commandId: "yield_pools.yield_pool_list",
          domain: "yield_pools",
          provider: "defillama",
          reason: "Fetch yield pools.",
          title: "Yield pool list",
        },
      ],
      intent: "defi",
      query: "by",
      rawQuery: "Rank Mantle protocols by TVL and yield momentum",
    },
    recommendation: "Confirm protocol risk before escalating the shortlist.",
    tools: [
      {
        commandId: "defi_tvl.defillama_protocols",
        data: [
          {
            chainTvls: {
              Mantle: 1200000,
            },
            chains: ["Mantle"],
            name: "Agni Finance",
            slug: "agni-finance",
          },
        ],
        domain: "defi_tvl",
        latencyMs: 12,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched DeFiLlama protocol TVL list.",
        title: "DeFi protocols TVL",
      },
      {
        commandId: "yield_pools.yield_pool_list",
        data: {
          data: [
            {
              apy: 12,
              chain: "Mantle",
              pool: "agni-usdt0",
              project: "agni-finance",
              symbol: "USDT0",
              tvlUsd: 300000,
            },
          ],
        },
        domain: "yield_pools",
        latencyMs: 8,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched 1 yield pool.",
        title: "Yield pool list",
      },
    ] satisfies OnChainToolResult[],
  });
  const workflowReport = buildWorkflowResearchReport({
    errors: [],
    generatedAt: "2026-05-23T04:49:00.000Z",
    onChain: {
      answer: onChainReport.executiveSummary,
      bullets: [],
      caveat: "This is analysis-only.",
      generatedAt: "2026-05-23T04:48:00.000Z",
      plan: {
        ...defaultPlan,
        intent: "defi",
        query: "Rank Mantle protocols by TVL and yield momentum",
      },
      recommendation: "Confirm protocol risk before escalating the shortlist.",
      report: onChainReport,
      title: "Mantle Yield and TVL Brief",
      tools: [],
    },
    signals: {
      ...defaultSignals,
      combined: {
        ...defaultSignals.combined,
        status: "success",
        summary: "Social and on-chain signals converged into a usable live research brief.",
      },
      onchain: {
        ...defaultSignals.onchain,
        status: "success",
        summary: "On-chain enrichment produced usable live evidence.",
      },
    },
    sources: [],
    topic: "Rank Mantle protocols by TVL and yield momentum",
  });

  assert.equal(workflowReport.kind, "defi-yield");
  assert.equal(workflowReport.entities[0]?.label, "Agni Finance");
  assert.equal(workflowReport.tables[0]?.id, "yield-table");
  assert.equal(workflowReport.executiveSummary, onChainReport.executiveSummary);
  assert.equal(workflowReport.bottomLine, onChainReport.bottomLine);
});

test("defi yield report falls back to summed Mantle pool TVL when direct protocol TVL is unavailable", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      intent: "defi",
      query: "Rank Mantle protocols by TVL and yield momentum",
    },
    recommendation: "Confirm protocol risk before escalating the shortlist.",
    tools: [
      {
        commandId: "yield_pools.yield_pool_list",
        data: {
          data: [
            {
              apy: 10,
              apyPct1D: 2,
              chain: "Mantle",
              pool: "cleopatra-usdt0",
              project: "cleopatra",
              symbol: "USDT0",
              tvlUsd: 125000,
            },
            {
              apy: 14,
              apyPct1D: 5,
              chain: "Mantle",
              pool: "cleopatra-meth",
              project: "cleopatra",
              symbol: "mETH",
              tvlUsd: 175000,
            },
          ],
        },
        domain: "yield_pools",
        latencyMs: 8,
        provider: "defillama",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched 2 yield pools.",
        title: "Yield pool list",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.entities[0]?.label, "Cleopatra");
  assert.equal(report.entities[0]?.metrics.tvlUsd, 300000);
  assert.equal(report.entities[0]?.metrics.bestApy, 14);
  assert.equal(report.entities[0]?.metrics.poolCount, 2);
  assert.equal(report.entities[0]?.metrics.coverage, "tvl+apy");
});

test("token discovery report builds a chain-filtered ranked shortlist from DEX and Gecko rows", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      chain: "solana",
      chainId: 1,
      chainName: "Solana",
      commands: [
        {
          commandId: "token_discovery.trending_boosted_tokens",
          domain: "token_discovery",
          provider: "dexscreener",
          reason: "Fetch boosts.",
          title: "Trending boosted tokens",
        },
        {
          commandId: "token_discovery.geckoterminal_trending_pools",
          domain: "token_discovery",
          provider: "geckoterminal",
          reason: "Fetch trending pools.",
          title: "GeckoTerminal trending pools",
        },
      ],
      intent: "token-discovery",
      query: "token Solana yang sedang tren",
      rawQuery: "token Solana yang sedang tren",
    },
    recommendation: "Confirm liquidity and token risk before escalating the shortlist.",
    tools: [
      {
        commandId: "token_discovery.trending_boosted_tokens",
        data: [
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
        ],
        domain: "token_discovery",
        latencyMs: 12,
        provider: "dexscreener",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched boosted tokens.",
        title: "Trending boosted tokens",
      },
      {
        commandId: "token_discovery.geckoterminal_trending_pools",
        data: {
          data: [
            {
              attributes: {
                address: "pool-sol",
                base_token_price_usd: "1.23",
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
        },
        domain: "token_discovery",
        latencyMs: 14,
        provider: "geckoterminal",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched GeckoTerminal trending pools.",
        title: "GeckoTerminal trending pools",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "token-discovery");
  assert.equal(report.entities[0]?.label, "SOLX");
  assert.equal(
    report.entities[0]?.metrics.tokenAddress,
    "So11111111111111111111111111111111111111112"
  );
  assert.equal(report.entities[0]?.metrics.boostAmount, 800);
  assert.equal(report.entities[0]?.metrics.liquidityUsd, 150000);
  assert.equal(report.entities[0]?.metrics.volume24hUsd, 450000);
  assert.equal(report.entities[0]?.metrics.priceChange24h, 21.5);
  assert.equal(report.entities[0]?.metrics.poolCount, 1);
  assert.equal(report.entities[0]?.metrics.coverage, "boost+pool");
  assert.equal(report.tables[0]?.id, "token-discovery-table");
  assert.ok(
    !report.entities.some((entity) =>
      String(entity.metrics.tokenAddress).includes("0000000000000001")
    )
  );
});

test("token discovery report still ranks address-only DEX rows when GeckoTerminal fails", () => {
  const report = buildOnChainResearchReport({
    caveat: "This is analysis-only and GeckoTerminal failed.",
    generatedAt: "2026-05-23T04:48:00.000Z",
    plan: {
      ...defaultPlan,
      chain: "base",
      chainId: 8453,
      chainName: "Base",
      intent: "token-discovery",
      query: "Find trending tokens on Base",
      rawQuery: "Find trending tokens on Base",
    },
    recommendation: "Confirm liquidity and token risk before escalating the shortlist.",
    tools: [
      {
        commandId: "token_discovery.trending_boosted_tokens",
        data: [
          {
            chainId: "base",
            tokenAddress: "0x1234567890abcdef1234567890abcdef12345678",
            totalAmount: 500,
            url: "https://dexscreener.com/base/0x1234567890abcdef1234567890abcdef12345678",
          },
        ],
        domain: "token_discovery",
        latencyMs: 12,
        provider: "dexscreener",
        scope: "legacy-default",
        status: "success",
        summary: "Fetched boosted tokens.",
        title: "Trending boosted tokens",
      },
      {
        commandId: "token_discovery.geckoterminal_trending_pools",
        domain: "token_discovery",
        error: "401 Unauthorized",
        latencyMs: 14,
        provider: "geckoterminal",
        scope: "legacy-default",
        status: "failed",
        summary: "401 Unauthorized",
        title: "GeckoTerminal trending pools",
      },
    ] satisfies OnChainToolResult[],
  });

  assert.equal(report.kind, "token-discovery");
  assert.equal(report.entities[0]?.label, "0x1234...5678");
  assert.equal(report.entities[0]?.metrics.coverage, "single-source");
  assert.match(report.executiveSummary, /ranked on-chain shortlist from partial coverage/i);
});
