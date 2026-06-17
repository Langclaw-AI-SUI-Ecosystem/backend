import type {
  ProviderName,
  ProviderResult,
  SourceCard,
} from "./types";

export function providerFailure(
  provider: ProviderName,
  message: string
): ProviderResult {
  return {
    errors: [
      {
        message,
        provider,
      },
    ],
    providerTrace: [],
    sources: [],
  };
}

export function dedupeSources(sources: SourceCard[]) {
  const seen = new Set<string>();
  const deduped: SourceCard[] = [];

  for (const source of sources) {
    const key = source.url.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(source);
  }

  return deduped;
}

export function compactTitle(text: string, fallback: string) {
  const clean = text.replace(/\s+/g, " ").trim();

  if (!clean) {
    return fallback;
  }

  return clean.length > 96 ? `${clean.slice(0, 93)}...` : clean;
}

export function cleanExcerpt(text: string) {
  const clean = text.replace(/\s+/g, " ").trim();

  if (!clean) {
    return "Live source discovered for this topic.";
  }

  return clean.length > 220 ? `${clean.slice(0, 217)}...` : clean;
}

export function cleanError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isAbortTimeoutError(error: unknown) {
  const message = cleanError(error).toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("aborted") ||
    message.includes("abort")
  );
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function responseMessage(response: Response) {
  const text = await response.text();
  const compact = text.replace(/\s+/g, " ").trim();

  if (!compact) {
    return `${response.status} ${response.statusText}`;
  }

  return `${response.status} ${response.statusText}: ${compact.slice(0, 240)}`;
}

export function hashId(value: string) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}
