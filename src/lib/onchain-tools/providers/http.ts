type FetchJsonOptions = {
  headers?: HeadersInit;
  method?: string;
  body?: BodyInit;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function fetchJson(
  url: string,
  {
    body,
    headers,
    method,
    signal,
    timeoutMs = 12000,
  }: FetchJsonOptions = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();

  signal?.addEventListener("abort", abort, { once: true });

  try {
    const response = await fetch(url, {
      body,
      headers,
      method,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const compact = text.replace(/\s+/g, " ").trim();
      throw new Error(
        `${response.status} ${response.statusText}${
          compact ? `: ${compact.slice(0, 200)}` : ""
        }`
      );
    }

    return response.json() as Promise<unknown>;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function compactText(value: unknown, fallback = "No summary returned.") {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 0) ?? "";
  const compact = text.replace(/\s+/g, " ").trim();

  if (!compact) {
    return fallback;
  }

  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact;
}

export function requireEnv(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is not configured.`);
  }

  return value;
}
