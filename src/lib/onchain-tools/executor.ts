import {
  getAccountBalance,
  getCode,
  getTokenBalance,
  getTokenTransfers,
  getTxList,
} from "./providers/etherscan";
import {
  getAssetTransfers,
  getTokenBalances,
  getTokenMetadata,
} from "./providers/alchemy";
import {
  getCoinMarkets,
  searchCoin,
} from "./providers/coingecko";
import {
  getAddressSecurity,
  getTokenSecurity,
} from "./providers/goplus";
import {
  getLatestBoostedTokens,
  getLatestTokenProfiles,
  getPaidOrders,
  getPairSnapshot,
  getTokenPairs,
  getTokenSnapshot,
  getTopBoostedTokens,
  searchPairs,
} from "./providers/dexscreener";
import {
  getChains,
  getProtocol,
  getProtocols,
  getStablecoins,
  getYieldPools,
} from "./providers/defillama";
import {
  getLatestResult,
  getSmartMoneyDexBuyCandidates,
  getSuiAccumulationFlow,
} from "./providers/dune";
import { getTrendingNarratives } from "./providers/elfa";
import {
  getNetworkNewPools,
  getNetworkTrendingPools,
  getPoolData,
  getTokenData as getGeckoTerminalTokenData,
  getTokenInfo,
  getTokenTopHolders,
} from "./providers/geckoterminal";
import {
  describeEmptySmartMoneyEvidence,
  shouldRejectEmptySmartMoneyEvidence,
} from "./evidence";
import type {
  OnChainExecuteInput,
  OnChainExecutorId,
  OnChainPlan,
  OnChainProvider,
  OnChainProviderResponse,
  OnChainToolCallEvent,
  OnChainToolResult,
} from "./types";
import { getSmartMoneyNetflow } from "./providers/nansen";
import { getSuiCoinHolders } from "./providers/sui-blockvision";
import {
  getSurfSmartMoneyResearch,
  getSurfWebSearch,
} from "./providers/surf";

type Executor = (input: OnChainExecuteInput) => Promise<OnChainProviderResponse>;

const executors: Record<OnChainExecutorId, Executor> = {
  "alchemy.asset_transfers": (input) =>
    getAssetTransfers({
      chain: input.chain,
      signal: input.signal,
      walletAddress: input.walletAddress,
    }),
  "alchemy.token_balances": (input) =>
    getTokenBalances({
      chain: input.chain,
      signal: input.signal,
      walletAddress: input.walletAddress,
    }),
  "alchemy.token_metadata": (input) =>
    getTokenMetadata({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "coingecko.coin_markets": (input) =>
    getCoinMarkets({
      query: input.query,
      signal: input.signal,
    }),
  "coingecko.search_coin": (input) =>
    searchCoin({
      query: input.query,
      signal: input.signal,
    }),
  "defillama.chains": (input) =>
    getChains({ chain: input.chain, query: input.query, signal: input.signal }),
  "defillama.protocol": (input) =>
    getProtocol({ chain: input.chain, query: input.query, signal: input.signal }),
  "defillama.protocols": (input) =>
    getProtocols({ chain: input.chain, query: input.query, signal: input.signal }),
  "defillama.stablecoins": (input) =>
    getStablecoins({ chain: input.chain, query: input.query, signal: input.signal }),
  "defillama.yield_pools": (input) =>
    getYieldPools({ chain: input.chain, query: input.query, signal: input.signal }),
  "dexscreener.latest_boosts": (input) =>
    getLatestBoostedTokens({ chain: input.chain, query: input.query, signal: input.signal }),
  "dexscreener.latest_profiles": (input) =>
    getLatestTokenProfiles({ chain: input.chain, query: input.query, signal: input.signal }),
  "dexscreener.orders": (input) =>
    getPaidOrders({
      chain: input.chain,
      query: input.query,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "dexscreener.pair_snapshot": (input) =>
    getPairSnapshot({
      chain: input.chain,
      pairAddress: input.tokenAddress,
      query: input.query,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "dexscreener.search_pairs": (input) =>
    searchPairs({ chain: input.chain, query: input.query, signal: input.signal }),
  "dexscreener.token_pairs": (input) =>
    getTokenPairs({
      chain: input.chain,
      query: input.query,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "dexscreener.token_snapshot": (input) =>
    getTokenSnapshot({
      chain: input.chain,
      query: input.query,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "dexscreener.top_boosts": (input) =>
    getTopBoostedTokens({ chain: input.chain, query: input.query, signal: input.signal }),
  "dune.latest_result": (input) =>
    getLatestResult({ query: input.rawQuery ?? input.query, signal: input.signal }),
  "dune.smart_money_sql": (input) =>
    getSmartMoneyDexBuyCandidates({
      chain: input.chain,
      query: input.query,
      rawQuery: input.rawQuery,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "dune.sui_accumulation_flow": (input) =>
    getSuiAccumulationFlow({
      chain: input.chain,
      query: input.query,
      rawQuery: input.rawQuery,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "elfa.trending_narratives": (input) =>
    getTrendingNarratives({ signal: input.signal }),
  "etherscan.account_balance": (input) =>
    getAccountBalance({
      chain: input.chain,
      signal: input.signal,
      walletAddress: input.walletAddress,
    }),
  "etherscan.get_code": (input) =>
    getCode({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "etherscan.token_balance": (input) =>
    getTokenBalance({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
      walletAddress: input.walletAddress,
    }),
  "etherscan.token_transfers": (input) =>
    getTokenTransfers({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
      walletAddress: input.walletAddress,
    }),
  "etherscan.txlist": (input) =>
    getTxList({
      chain: input.chain,
      signal: input.signal,
      walletAddress: input.walletAddress,
    }),
  "goplus.address_security": (input) =>
    getAddressSecurity({
      chain: input.chain,
      signal: input.signal,
      walletAddress: input.walletAddress,
    }),
  "geckoterminal.network_new_pools": (input) =>
    getNetworkNewPools({
      chain: input.chain,
      signal: input.signal,
    }),
  "geckoterminal.network_trending_pools": (input) =>
    getNetworkTrendingPools({
      chain: input.chain,
      signal: input.signal,
    }),
  "geckoterminal.pool_data": (input) =>
    getPoolData({
      chain: input.chain,
      pairAddress: input.tokenAddress,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "geckoterminal.token_data": (input) =>
    getGeckoTerminalTokenData({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "geckoterminal.token_info": (input) =>
    getTokenInfo({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "geckoterminal.token_top_holders": (input) =>
    getTokenTopHolders({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "goplus.token_security": (input) =>
    getTokenSecurity({
      chain: input.chain,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "nansen.smart_money_netflow": (input) =>
    getSmartMoneyNetflow({
      chain: input.chain,
      signal: input.signal,
    }),
  "blockvision.coin_holders": (input) =>
    getSuiCoinHolders({
      chain: input.chain,
      query: input.query,
      rawQuery: input.rawQuery,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
    }),
  "surf.chat_completions": (input) =>
    getSurfSmartMoneyResearch({
      chain: input.chain,
      query: input.query ?? input.rawQuery,
      signal: input.signal,
      tokenAddress: input.tokenAddress,
      walletAddress: input.walletAddress,
    }),
  "local.signal_synthesis": async (input) => ({
    data: {
      completedTools: input.previousResults.filter((result) => result.status === "success").length,
      failedTools: input.previousResults.filter((result) => result.status === "failed").length,
      summaries: input.previousResults.map((result) => result.summary),
    },
    summary: summarizePreviousResults(input.previousResults),
  }),
  "surf.web_search": (input) =>
    getSurfWebSearch({ query: input.query, signal: input.signal }),
};

const cache = new Map<string, { expiresAt: number; result: OnChainToolResult }>();

export async function executeOnChainPlan({
  onToolCall,
  onToolResult,
  plan,
  signal,
}: {
  onToolCall?: (event: OnChainToolCallEvent) => void | Promise<void>;
  onToolResult?: (event: OnChainToolResult) => void | Promise<void>;
  plan: OnChainPlan;
  signal?: AbortSignal;
}) {
  const results: OnChainToolResult[] = [];

  for (const planned of plan.commands) {
    const { command, reason } = planned;
    await onToolCall?.({
      commandId: command.id,
      domain: command.domain,
      provider: command.provider,
      reason,
      title: command.title,
    });

    const result = await executeCommand({
      chain: plan.chain,
      chainId: plan.chainId,
      command,
      previousResults: results,
      rawQuery: plan.rawQuery,
      query: plan.query,
      signal,
      tokenAddress: plan.tokenAddress,
      walletAddress: plan.walletAddress,
    });
    results.push(result);
    await onToolResult?.(result);
  }

  return results;
}

export function isExecutorAvailable(executor: OnChainExecutorId) {
  return executor in executors;
}

async function executeCommand(input: OnChainExecuteInput): Promise<OnChainToolResult> {
  const startedAt = Date.now();
  const cacheKey = buildCacheKey(input);
  const cached = readCache(cacheKey);

  if (cached) {
    return {
      ...cached,
      latencyMs: 0,
      summary: `${cached.summary} Cache hit.`,
    };
  }

  const attempts = [
    {
      executor: input.command.executor,
      provider: input.command.provider,
    },
    ...(input.command.fallback ?? []),
  ];
  const attemptedProviders: OnChainProvider[] = [];
  const errors: Array<{ message: string; provider: OnChainProvider }> = [];
  const emptyResponses: Array<{
    message: string;
    provider: OnChainProvider;
    response: OnChainProviderResponse;
  }> = [];

  for (const attempt of attempts) {
    const executor = executors[attempt.executor];

    if (!executor) {
      errors.push({
        message: `Executor ${attempt.executor} is not registered.`,
        provider: attempt.provider,
      });
      attemptedProviders.push(attempt.provider);
      continue;
    }

    attemptedProviders.push(attempt.provider);

    try {
      const response = await executor(input);

      if (
        shouldRejectEmptySmartMoneyEvidence({
          command: input.command,
          data: response.data,
          provider: attempt.provider,
        })
      ) {
        const message = describeEmptySmartMoneyEvidence(attempt.provider);
        errors.push({
          message,
          provider: attempt.provider,
        });
        emptyResponses.push({
          message,
          provider: attempt.provider,
          response,
        });
        continue;
      }

      const result: OnChainToolResult = {
        attemptedProviders,
        commandId: input.command.id,
        data: response.data,
        domain: input.command.domain,
        fallbackReason: buildFallbackReason(errors),
        latencyMs: Date.now() - startedAt,
        provider: attempt.provider,
        scope: errors.length
          ? "legacy-fallback"
          : input.command.scope ?? "legacy-default",
        sourceUrl: response.sourceUrl || input.command.docsUrl,
        status: "success",
        summary: response.summary || "Tool completed.",
        title: input.command.title,
      };

      writeCache(cacheKey, input.command.cacheTtlSeconds, result);

      return result;
    } catch (error) {
      errors.push({
        message:
          error instanceof Error ? error.message : "Tool execution failed.",
        provider: attempt.provider,
      });
    }
  }

  const primaryEmptyResponse = emptyResponses[0];

  return {
    attemptedProviders,
    commandId: input.command.id,
    data: primaryEmptyResponse?.response.data,
    domain: input.command.domain,
    error: errors[0]?.message ?? "Tool execution failed.",
    fallbackReason: buildFallbackReason(errors),
    latencyMs: Date.now() - startedAt,
    provider: errors[0]?.provider ?? input.command.provider,
    scope: errors.length > 1 ? "legacy-fallback" : input.command.scope ?? "legacy-default",
    sourceUrl: primaryEmptyResponse?.response.sourceUrl || input.command.docsUrl,
    status: "failed",
    summary:
      primaryEmptyResponse?.response.summary ||
      errors[0]?.message ||
      "Tool execution failed.",
    title: input.command.title,
  };
}

function buildCacheKey(input: OnChainExecuteInput) {
  return JSON.stringify({
    chain: input.chain,
    commandId: input.command.id,
    rawQuery: input.rawQuery,
    query: input.query,
    tokenAddress: input.tokenAddress,
    walletAddress: input.walletAddress,
  });
}

function readCache(key: string) {
  const cached = cache.get(key);

  if (!cached || cached.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }

  return cached.result;
}

function writeCache(key: string, ttlSeconds: number, result: OnChainToolResult) {
  if (ttlSeconds <= 0 || result.status !== "success") {
    return;
  }

  cache.set(key, {
    expiresAt: Date.now() + ttlSeconds * 1000,
    result,
  });
}

function summarizePreviousResults(results: OnChainToolResult[]) {
  const successes = results.filter((result) => result.status === "success");
  const failures = results.filter((result) => result.status === "failed");

  return `Synthesized ${successes.length} successful tool results and ${failures.length} failed tool results into an analysis-only signal.`;
}

function buildFallbackReason(
  errors: Array<{ message: string; provider: OnChainProvider }>
) {
  if (!errors.length) {
    return undefined;
  }

  return errors
    .map((entry) => `${entry.provider}: ${entry.message}`)
    .join(" | ");
}
