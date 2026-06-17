import { readPremiumProviderConfig } from "../../premium-providers";
import {
  cleanError,
  cleanExcerpt,
  delay,
  hashId,
  isAbortTimeoutError,
  providerFailure,
  responseMessage,
} from "../provider-utils";
import type { ProviderResult } from "../types";

type ElfaNarrative = {
  mention_count?: number;
  mentions?: number;
  name?: string;
  narrative?: string;
  sentiment?: string;
  source_links?: string[];
};

type ElfaNarrativesResponse = {
  data?:
    | ElfaNarrative[]
    | {
        narratives?: ElfaNarrative[];
        trending_narratives?: ElfaNarrative[];
      };
  narratives?: ElfaNarrative[];
  results?: ElfaNarrative[];
  trending_narratives?: ElfaNarrative[];
};

export async function discoverElfa(topic: string): Promise<ProviderResult> {
  const config = readPremiumProviderConfig("elfa");

  if (!config.enabled) {
    return providerFailure(
      "Elfa",
      "Elfa discovery is not configured. Set ELFA_ENABLED=true and ELFA_API_KEY."
    );
  }

  const url = new URL("https://api.elfa.ai/v2/data/trending-narratives");
  const maxAttempts = 2;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "x-elfa-api-key": config.apiKey,
        },
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) {
        return providerFailure("Elfa", await responseMessage(response));
      }

      const payload = (await response.json()) as ElfaNarrativesResponse;
      const results = normalizeElfaNarratives(payload);

      if (!results.length) {
        return providerFailure("Elfa", "Elfa returned no trending narratives.");
      }

      return {
        errors: [],
        providerTrace: [],
        sources: results.slice(0, 3).map((result, index) => {
          const label = result.name ?? result.narrative ?? "crypto narrative";
          const mentions = result.mention_count ?? result.mentions;
          const sourceUrl = result.source_links?.find(Boolean);

          return {
            excerpt: cleanExcerpt(
              `${label} is trending across Elfa signals. Mentions: ${mentions ?? "unknown"}. Sentiment: ${result.sentiment ?? "unknown"}.`
            ),
            id: `elfa-narrative-${index}-${hashId(label)}`,
            metrics: {
              mentions,
              sentiment: result.sentiment,
              topic,
            },
            provider: "Elfa" as const,
            title: `Elfa narrative: ${label}`,
            type: "docs_page" as const,
            url:
              sourceUrl ||
              "https://docs.elfa.ai/api/rest/get-trending-narratives-v-2/",
          };
        }),
      };
    } catch (error) {
      if (attempt < maxAttempts && isAbortTimeoutError(error)) {
        await delay(retryDelayMs);
        continue;
      }

      return providerFailure("Elfa", cleanError(error));
    }
  }

  return providerFailure("Elfa", "Elfa discovery failed after retries.");
}

function normalizeElfaNarratives(payload: ElfaNarrativesResponse) {
  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (payload.data && typeof payload.data === "object") {
    const nested = payload.data;

    if (Array.isArray(nested.trending_narratives)) {
      return nested.trending_narratives;
    }

    if (Array.isArray(nested.narratives)) {
      return nested.narratives;
    }
  }

  if (Array.isArray(payload.trending_narratives)) {
    return payload.trending_narratives;
  }

  if (Array.isArray(payload.narratives)) {
    return payload.narratives;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  return [];
}
