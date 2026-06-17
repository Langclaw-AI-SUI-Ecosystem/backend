import type { OnChainProviderResponse } from "../types";
import { compactText, fetchJson, requireEnv } from "./http";

type ElfaOptions = {
  signal?: AbortSignal;
};

export async function getTrendingNarratives(
  options: ElfaOptions
): Promise<OnChainProviderResponse> {
  const sourceUrl = "https://api.elfa.ai/v2/data/trending-narratives";
  const data = await fetchJson(sourceUrl, {
    headers: {
      "x-elfa-api-key": requireEnv("ELFA_API_KEY"),
    },
    signal: options.signal,
    timeoutMs: readTimeout("ELFA_TIMEOUT_MS"),
  });

  return {
    data,
    sourceUrl,
    summary: `Fetched Elfa trending narratives. ${compactText(data)}`,
  };
}

function readTimeout(name: string) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) && value > 0 ? value : 12000;
}
