import assert from "node:assert/strict";

type EnvMap = Record<string, string | undefined>;

export async function withEnv<T>(
  values: EnvMap,
  run: () => T | Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export function mockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>
) {
  const previous = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    return Promise.resolve(handler(url, init));
  }) as typeof fetch;

  return () => {
    globalThis.fetch = previous;
  };
}

export function jsonResponse(
  payload: unknown,
  init: ResponseInit = {}
) {
  const headers = new Headers(init.headers);

  headers.set("Content-Type", "application/json");

  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

export function sseResponse(lines: string[], init: ResponseInit = {}) {
  const body = lines.map((line) => `${line}\n`).join("");
  const headers = new Headers(init.headers);

  headers.set("Content-Type", "text/event-stream");

  return new Response(body, {
    ...init,
    headers,
  });
}

export async function readNdjson(response: Response) {
  const text = await response.text();

  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function assertPath(url: string, expected: string) {
  assert.equal(new URL(url).pathname, expected);
}
