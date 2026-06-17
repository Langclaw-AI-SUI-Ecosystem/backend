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

type SurfWebItem = {
  content?: string;
  snippet?: string;
  title?: string;
  url?: string;
};

type SurfWebResponse = {
  data?: SurfWebItem[];
  items?: SurfWebItem[];
  results?: SurfWebItem[];
};

export async function discoverSurf(topic: string): Promise<ProviderResult> {
  const config = readPremiumProviderConfig("surf");

  if (!config.enabled) {
    return providerFailure(
      "Surf",
      "Surf discovery is not configured. Set SURF_ENABLED=true and SURF_API_KEY."
    );
  }

  const url = new URL("https://api.asksurf.ai/gateway/v1/search/web");
  url.searchParams.set("q", topic);
  url.searchParams.set("limit", "3");

  const maxAttempts = 2;
  const retryDelayMs = 2000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
        signal: AbortSignal.timeout(config.timeoutMs),
      });

      if (!response.ok) {
        return providerFailure("Surf", await responseMessage(response));
      }

      const payload = (await response.json()) as SurfWebResponse;
      const results = payload.data ?? payload.items ?? payload.results ?? [];

      return {
        errors: [],
        providerTrace: [],
        sources: results.slice(0, 3).map((result, index) => ({
          excerpt: cleanExcerpt(result.content ?? result.snippet ?? ""),
          id: `surf-web-${index}-${hashId(result.url ?? result.title ?? "")}`,
          provider: "Surf" as const,
          title: result.title || "Surf market intelligence",
          type: "docs_page" as const,
          url: result.url || "https://docs.asksurf.ai/",
        })),
      };
    } catch (error) {
      if (attempt < maxAttempts && isAbortTimeoutError(error)) {
        await delay(retryDelayMs);
        continue;
      }

      return providerFailure("Surf", cleanError(error));
    }
  }

  return providerFailure("Surf", "Surf discovery failed after retries.");
}
