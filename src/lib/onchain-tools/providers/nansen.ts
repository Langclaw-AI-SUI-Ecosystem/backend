import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson, requireEnv } from "./http";

type NansenOptions = {
  chain: string;
  signal?: AbortSignal;
};

const baseUrl = "https://api.nansen.ai/api/v1";

export async function getSmartMoneyNetflow(
  options: NansenOptions
): Promise<OnChainProviderResponse> {
  const data = await fetchJson(`${baseUrl}/smart-money/netflow`, {
    body: JSON.stringify({
      chains: [options.chain],
      filters: {
        include_smart_money_labels: ["Fund", "Smart Trader"],
      },
      order_by: [{ direction: "DESC", field: "net_flow_7d_usd" }],
      pagination: {
        page: 1,
        per_page: 10,
      },
    }),
    headers: {
      "Content-Type": "application/json",
      apiKey: requireEnv("NANSEN_API_KEY"),
    },
    method: "POST",
    signal: options.signal,
    timeoutMs: readTimeout("NANSEN_TIMEOUT_MS"),
  });

  return {
    data,
    sourceUrl: `${baseUrl}/smart-money/netflow`,
    summary: `Fetched Nansen smart-money netflow for ${options.chain}. ${compactText(data)}`,
  };
}

function readTimeout(name: string) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? value : 12000;
}
