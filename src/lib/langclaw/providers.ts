import { resolveProductChain } from "../chain-config";
import {
  isPremiumProviderInScope,
  type PremiumProviderId,
} from "../premium-providers";
import {
  cleanError,
  cleanExcerpt,
  compactTitle,
  dedupeSources,
  hashId,
  providerFailure,
  responseMessage,
} from "./provider-utils";
import { discoverElfa } from "./providers/elfa";
import { discoverSurf } from "./providers/surf";
import type {
  ProviderError,
  ProviderName,
  ProviderResult,
  ProviderTraceEntry,
  SourceCard,
  SourceType,
} from "./types";

type XTweet = {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count?: number;
    reply_count?: number;
    like_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    impression_count?: number;
  };
};

type XUser = {
  id: string;
  name?: string;
  username?: string;
};

type GitHubRepository = {
  id: number;
  full_name: string;
  html_url: string;
  description: string | null;
  owner?: {
    login?: string;
  };
  updated_at?: string;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  language?: string | null;
};

type TavilyResult = {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
  score?: number;
};

type TavilyResponse = {
  results?: TavilyResult[];
};

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  extra_snippets?: string[];
  age?: string;
  page_age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type SearchEngine = "Tavily" | "Brave";

type WebSearchResult = {
  title?: string;
  url?: string;
  content?: string;
  raw_content?: string;
  score?: number;
  publishedAt?: string;
  engine: SearchEngine;
};

type DiscoveryOptions = {
  chain?: string;
};

const JSON_HEADERS = {
  "Content-Type": "application/json",
};

export async function runProviderDiscovery(
  topic: string,
  options: DiscoveryOptions = {}
): Promise<ProviderResult> {
  const chain = resolveProductChain(options.chain).id;
  const sources: SourceCard[] = [];
  const errors: ProviderError[] = [];
  const providerTrace: ProviderTraceEntry[] = [];

  if (isPremiumProviderInScope(chain)) {
    const premiumScope = "sui-premium" as const;
    const premiumResults = await Promise.all([
      runTimedDiscovery(discoverSurf(topic), "Surf"),
      runTimedDiscovery(discoverElfa(topic), "Elfa"),
    ]);

    for (const { provider, result } of premiumResults) {
      mergeProviderResult(
        result,
        premiumScope,
        sources,
        errors,
        providerTrace,
        provider
      );
    }
    providerTrace.push({
      message: "Nansen is reserved for the structured on-chain workflow.",
      provider: "Nansen",
      scope: premiumScope,
      status: "skipped",
    });

    if (shouldRunLegacyFallback(topic, sources.length)) {
      await collectLegacyProviders(topic, sources, errors, providerTrace, "legacy-fallback");
    } else {
      providerTrace.push(
        skippedLegacyTrace("X", "Premium research providers already returned enough evidence."),
        skippedLegacyTrace("GitHub", "Premium research providers already returned enough evidence."),
        skippedLegacyTrace("Tavily", "Premium research providers already returned enough evidence."),
        skippedLegacyTrace("HackQuest", "Premium research providers already returned enough evidence.")
      );
    }
  } else {
    providerTrace.push(
      ...(["surf", "nansen", "elfa"] as const).map((provider) =>
        skippedPremiumTrace(provider, "Premium provider rollout is limited on this backend.")
      )
    );
    await collectLegacyProviders(topic, sources, errors, providerTrace, "legacy-default");
  }

  return {
    errors,
    providerTrace,
    sources: dedupeSources(sources),
  };
}

async function collectLegacyProviders(
  topic: string,
  sources: SourceCard[],
  errors: ProviderError[],
  providerTrace: ProviderTraceEntry[],
  scope: "legacy-default" | "legacy-fallback"
) {
  const providerResults = await Promise.allSettled([
    discoverX(topic),
    discoverGitHub(topic),
    discoverDocs(topic),
    discoverHackQuest(topic),
  ]);

  for (const result of providerResults) {
    if (result.status === "fulfilled") {
      mergeProviderResult(result.value, scope, sources, errors, providerTrace);
      continue;
    }

    errors.push({
      message: cleanError(result.reason),
      provider: "Tavily",
    });
    providerTrace.push({
      message: cleanError(result.reason),
      provider: "Tavily",
      scope,
      status: "failed",
    });
  }
}

async function runTimedDiscovery(
  promise: Promise<ProviderResult>,
  provider: ProviderName
) {
  const startedAt = Date.now();
  const result = await promise;
  const durationMs = Date.now() - startedAt;
  const status = result.sources.length > 0 ? "success" : "failed";

  console.info(
    `[discovery] ${provider} ${status} in ${durationMs}ms (${result.sources.length} source card(s))`
  );

  return { provider, result };
}

function mergeProviderResult(
  result: ProviderResult,
  scope: ProviderTraceEntry["scope"],
  sources: SourceCard[],
  errors: ProviderError[],
  providerTrace: ProviderTraceEntry[],
  providerOverride?: ProviderName
) {
  sources.push(...result.sources);
  errors.push(...result.errors);
  providerTrace.push(...result.providerTrace);

  const provider = providerOverride ?? result.sources[0]?.provider ?? result.errors[0]?.provider;

  if (!provider) {
    return;
  }

  if (result.sources.length > 0) {
    providerTrace.push({
      message: `Collected ${result.sources.length} source card(s).`,
      provider,
      scope,
      sourceCount: result.sources.length,
      status: "success",
    });
    return;
  }

  const message = result.errors[0]?.message ?? "No source cards were returned.";
  providerTrace.push({
    message,
    provider,
    scope,
    status: "failed",
  });
}

function shouldRunLegacyFallback(topic: string, sourceCount: number) {
  if (sourceCount < 3) {
    return true;
  }

  return /\b(github|repo|sdk|docs|builder|integration|hackathon|project)\b/i.test(
    topic
  );
}

function skippedLegacyTrace(provider: ProviderName, message: string): ProviderTraceEntry {
  return {
    message,
    provider,
    scope: "legacy-fallback",
    status: "skipped",
  };
}

function skippedPremiumTrace(
  provider: PremiumProviderId,
  message: string
): ProviderTraceEntry {
  return {
    message,
    provider:
      provider === "surf" ? "Surf" : provider === "elfa" ? "Elfa" : "Nansen",
    scope: "out-of-scope",
    status: "skipped",
  };
}

async function discoverX(topic: string): Promise<ProviderResult> {
  const mode = process.env.X_DISCOVERY_PROVIDER ?? "brave";

  if (mode === "x-api") {
    return discoverXApi(topic);
  }

  return discoverXWithBrave(topic);
}

async function discoverXWithBrave(topic: string): Promise<ProviderResult> {
  const response = await braveSearch(buildBraveXQuery(topic), 4);

  if ("error" in response) {
    return providerFailure(
      "X",
      `Brave Search X discovery failed: ${response.error}`
    );
  }

  const sources = response.results
    .filter((result) => {
      const url = result.url ?? "";
      return url.includes("x.com/") || url.includes("twitter.com/");
    })
    .slice(0, 4)
    .map((result, index) => ({
      id: `x-brave-${index}-${hashId(result.url ?? result.title ?? "")}`,
      type: "x_post" as const,
      title: result.title || "X result from Brave Search",
      url: result.url || "https://x.com/search",
      publishedAt: result.publishedAt,
      excerpt: cleanExcerpt(result.content ?? result.raw_content ?? ""),
      provider: "X" as const,
      metrics: {
        searchProvider: result.engine,
      },
    }));

  return {
    errors: [],
    providerTrace: [],
    sources,
  };
}

async function discoverXApi(topic: string): Promise<ProviderResult> {
  const token = process.env.X_BEARER_TOKEN;

  if (!token) {
    return providerFailure(
      "X",
      "Missing X_BEARER_TOKEN. Add it to .env.local for live X discovery."
    );
  }

  const url = new URL("https://api.x.com/2/tweets/search/recent");
  url.searchParams.set("query", buildXQuery(topic));
  url.searchParams.set("max_results", "10");
  url.searchParams.set(
    "tweet.fields",
    "created_at,author_id,public_metrics,lang"
  );
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "name,username");

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      return providerFailure("X", await responseMessage(response));
    }

    const payload = (await response.json()) as {
      data?: XTweet[];
      includes?: {
        users?: XUser[];
      };
    };

    const users = new Map(
      (payload.includes?.users ?? []).map((user) => [user.id, user])
    );

    const sources =
      payload.data?.slice(0, 4).map((tweet) => {
        const user = tweet.author_id ? users.get(tweet.author_id) : undefined;
        const username = user?.username;

        return {
          id: `x-${tweet.id}`,
          type: "x_post" as const,
          title: compactTitle(tweet.text, "X post"),
          url: username
            ? `https://x.com/${username}/status/${tweet.id}`
            : `https://x.com/i/web/status/${tweet.id}`,
          author: username ? `@${username}` : user?.name,
          publishedAt: tweet.created_at,
          excerpt: tweet.text,
          provider: "X" as const,
          metrics: {
            likes: tweet.public_metrics?.like_count,
            reposts: tweet.public_metrics?.retweet_count,
            replies: tweet.public_metrics?.reply_count,
            quotes: tweet.public_metrics?.quote_count,
          },
        };
      }) ?? [];

    return { errors: [], providerTrace: [], sources };
  } catch (error) {
    return providerFailure("X", cleanError(error));
  }
}

async function discoverGitHub(topic: string): Promise<ProviderResult> {
  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    return providerFailure(
      "GitHub",
      "Missing GITHUB_TOKEN. Add it to .env.local for live GitHub discovery."
    );
  }

  const url = new URL("https://api.github.com/search/repositories");
  url.searchParams.set("q", buildGitHubQuery(topic));
  url.searchParams.set("sort", "updated");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", "3");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      return providerFailure("GitHub", await responseMessage(response));
    }

    const payload = (await response.json()) as {
      items?: GitHubRepository[];
    };

    const sources =
      payload.items?.slice(0, 3).map((repo) => ({
        id: `github-${repo.id}`,
        type: "github_repo" as const,
        title: repo.full_name,
        url: repo.html_url,
        author: repo.owner?.login,
        publishedAt: repo.updated_at,
        excerpt:
          repo.description ??
          "GitHub repository discovered from the live topic query.",
        provider: "GitHub" as const,
        metrics: {
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          issues: repo.open_issues_count,
          language: repo.language ?? undefined,
        },
      })) ?? [];

    return { errors: [], providerTrace: [], sources };
  } catch (error) {
    return providerFailure("GitHub", cleanError(error));
  }
}

async function discoverDocs(topic: string): Promise<ProviderResult> {
  const response = await webSearch(
    `${topic} Sui on-chain data AI agent documentation`,
    3
  );

  if ("error" in response) {
    return providerFailure("Tavily", response.error);
  }

  return {
    errors: [],
    providerTrace: [],
    sources: response.results.slice(0, 3).map((result, index) => ({
      id: `docs-${index}-${hashId(result.url ?? result.title ?? "")}`,
      type: "docs_page" as const,
      title: result.title || "Documentation result",
      url: result.url || "https://docs.sui.io/",
      publishedAt: result.publishedAt,
      excerpt: cleanExcerpt(result.content ?? result.raw_content ?? ""),
      provider: "Tavily" as const,
      metrics: {
        score: result.score,
        searchProvider: result.engine,
      },
    })),
  };
}

async function discoverHackQuest(topic: string): Promise<ProviderResult> {
  const direct = await discoverHackQuestDirectory();
  const search = await webSearch(
    `${topic} site:hackquest.io/hackathons OR site:hackquest.io/projects`,
    4
  );

  const errors: ProviderError[] = [...direct.errors];
  const sources = [...direct.sources];

  if ("error" in search) {
    errors.push({
      provider: "HackQuest",
      message: `HackQuest web search failed: ${search.error}`,
    });
  } else {
    sources.push(
      ...search.results.slice(0, 4).map((result, index) => ({
        id: `hackquest-search-${index}-${hashId(result.url ?? result.title ?? "")}`,
        type: inferHackQuestType(result.url ?? ""),
        title: result.title || "HackQuest result",
        url: normalizeUrl(result.url || "https://www.hackquest.io/hackathons"),
        publishedAt: result.publishedAt,
        excerpt: cleanExcerpt(result.content ?? result.raw_content ?? ""),
        provider: "HackQuest" as const,
        metrics: {
          score: result.score,
          searchProvider: result.engine,
        },
      }))
    );
  }

  return {
    errors,
    providerTrace: [],
    sources: dedupeSources(sources).slice(0, 3),
  };
}

async function discoverHackQuestDirectory(): Promise<ProviderResult> {
  try {
    const response = await fetch("https://www.hackquest.io/hackathons", {
      headers: {
        Accept: "text/html",
        "User-Agent": "LangclawBot/0.1",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      return providerFailure("HackQuest", await responseMessage(response));
    }

    const html = await response.text();
    const text = htmlToText(html);
    const hrefs = extractHackQuestLinks(html);
    const hackathonUrl =
      hrefs.find((href) => /sui|walrus|overflow/i.test(href)) ??
      "https://sui.io/overflow";

    const directoryCard: SourceCard = {
      id: "hackquest-directory",
      type: "hackquest_hackathon",
      title: /Sui|Walrus|Overflow/i.test(text)
        ? "Sui Overflow Hackathon"
        : "HackQuest hackathon directory",
      url: normalizeUrl(hackathonUrl),
      excerpt: extractHackQuestExcerpt(text),
      provider: "HackQuest",
      metrics: extractHackQuestMetrics(text, "Sui Overflow Hackathon"),
    };

    return {
      errors: [],
      providerTrace: [],
      sources: [directoryCard],
    };
  } catch (error) {
    return providerFailure("HackQuest", cleanError(error));
  }
}

async function tavilySearch(
  query: string,
  maxResults: number
): Promise<{ results: WebSearchResult[] } | { error: string }> {
  const token = process.env.TAVILY_API_KEY;

  if (!token) {
    return {
      error: "Missing TAVILY_API_KEY. Add it to .env.local for live Tavily discovery.",
    };
  }

  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      return { error: await responseMessage(response) };
    }

    const payload = (await response.json()) as TavilyResponse;

    return {
      results: (payload.results ?? []).map((result) => ({
        ...result,
        engine: "Tavily",
      })),
    };
  } catch (error) {
    return { error: cleanError(error) };
  }
}

async function braveSearch(
  query: string,
  maxResults: number
): Promise<{ results: WebSearchResult[] } | { error: string }> {
  const token = process.env.BRAVE_SEARCH_API_KEY;

  if (!token) {
    return {
      error:
        "Missing BRAVE_SEARCH_API_KEY. Add it to .env.local for live Brave Search discovery.",
    };
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  url.searchParams.set("country", "us");
  url.searchParams.set("search_lang", "en");
  url.searchParams.set("safesearch", "moderate");

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": token,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      return { error: await responseMessage(response) };
    }

    const payload = (await response.json()) as BraveSearchResponse;

    return {
      results:
        payload.web?.results?.slice(0, maxResults).map((result) => ({
          title: result.title,
          url: result.url,
          content: [result.description, ...(result.extra_snippets ?? [])]
            .filter(Boolean)
            .join(" "),
          publishedAt: result.page_age ?? result.age,
          engine: "Brave",
        })) ?? [],
    };
  } catch (error) {
    return { error: cleanError(error) };
  }
}

async function webSearch(
  query: string,
  maxResults: number
): Promise<{ results: WebSearchResult[] } | { error: string }> {
  const tavilyToken = process.env.TAVILY_API_KEY;
  const braveToken = process.env.BRAVE_SEARCH_API_KEY;

  if (!tavilyToken && !braveToken) {
    return {
      error:
        "Missing TAVILY_API_KEY or BRAVE_SEARCH_API_KEY. Add one to .env.local for live web discovery.",
    };
  }

  if (tavilyToken) {
    const tavily = await tavilySearch(query, maxResults);

    if (!("error" in tavily)) {
      return tavily;
    }

    if (!braveToken) {
      return tavily;
    }

    const brave = await braveSearch(query, maxResults);

    if (!("error" in brave)) {
      return brave;
    }

    return {
      error: `Tavily failed: ${tavily.error}; Brave failed: ${brave.error}`,
    };
  }

  return braveSearch(query, maxResults);
}

function buildXQuery(topic: string) {
  return `(${topic}) (agent OR AI OR Web3 OR Sui OR Walrus OR product OR launch OR builder) -is:retweet lang:en`;
}

function buildBraveXQuery(topic: string) {
  return `site:x.com ${topic} agent AI Web3 Sui Walrus product launch builder`;
}

function buildGitHubQuery(topic: string) {
  return `${topic} agent orchestration web3 ai in:name,description,readme fork:false archived:false`;
}

function inferHackQuestType(url: string): SourceType {
  return url.includes("/projects/") ? "hackquest_project" : "hackquest_hackathon";
}

function normalizeUrl(url: string) {
  if (url.startsWith("http")) {
    return url;
  }

  return new URL(url, "https://www.hackquest.io").toString();
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function extractHackQuestLinks(html: string) {
  const hrefs = Array.from(html.matchAll(/href=["']([^"']+)["']/gi))
    .map((match) => match[1])
    .filter((href) => href.includes("/hackathons/") || href.includes("/projects/"))
    .map(normalizeUrl);

  return Array.from(new Set(hrefs));
}

function extractHackQuestExcerpt(text: string) {
  const marker = "Sui Overflow Hackathon";
  const index = text.indexOf(marker);

  if (index === -1) {
    return cleanExcerpt(text);
  }

  return cleanExcerpt(text.slice(index, index + 260));
}

function extractHackQuestMetrics(text: string, marker: string) {
  const index = text.indexOf(marker);
  const before = index === -1 ? text : text.slice(Math.max(0, index - 110), index);
  const after = index === -1 ? text : text.slice(index, index + 360);
  const participants = after.match(/Participants\s+([\d,]+)/i)?.[1];
  const prize = after.match(/Total Prizes\s*:\s*([\d,]+\s*USD)/i)?.[1];
  const status = before.match(
    /(Registration\s+(?:a\s+)?(?:\d+\s+)?[a-z]+\s+left|Upcoming|Ended)/i
  )?.[1];

  return {
    participants,
    prize,
    status,
  };
}
