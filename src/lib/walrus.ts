import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentHash, shortId } from "./hash";
import { stableStringify } from "./stable-json";
import type { SealEnvelope } from "./memory-types";

export type WalrusStoreResult = {
  walrusBlobId: string;
  walrusObjectId: string;
  suiTxDigest?: string;
};

export type WalrusClient = {
  storeEnvelope(envelope: SealEnvelope): Promise<WalrusStoreResult>;
  readEnvelope(blobId: string): Promise<SealEnvelope>;
};

export type WalrusStorageStatus = {
  mode: "http" | "local";
  configured: boolean;
  publisherUrl?: string;
  aggregatorUrl?: string;
  epochs?: number;
  timeoutMs?: number;
  localStoreDir?: string;
};

export function createWalrusClient(): WalrusClient {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL?.trim();
  const aggregatorUrl = process.env.WALRUS_AGGREGATOR_URL?.trim();

  if (publisherUrl && aggregatorUrl) {
    return new HttpWalrusClient(publisherUrl, aggregatorUrl, getWalrusEpochs());
  }

  return new LocalWalrusClient();
}

export function getWalrusStorageStatus(): WalrusStorageStatus {
  const publisherUrl = process.env.WALRUS_PUBLISHER_URL?.trim();
  const aggregatorUrl = process.env.WALRUS_AGGREGATOR_URL?.trim();

  if (publisherUrl && aggregatorUrl) {
    return {
      mode: "http",
      configured: true,
      publisherUrl,
      aggregatorUrl,
      epochs: getWalrusEpochs(),
      timeoutMs: getWalrusTimeoutMs(),
    };
  }

  return {
    mode: "local",
    configured: true,
    localStoreDir: getLocalWalrusDir(),
  };
}

/** Public aggregator URL that returns the stored blob, e.g.
 * `https://aggregator.walrus-mainnet.walrus.space/v1/blobs/<id>`. Returns
 * `undefined` in local-fallback mode (no public URL exists for an on-disk blob),
 * so callers can honestly distinguish a real, retrievable Walrus blob from a
 * local stand-in. */
export function getWalrusBlobUrl(blobId: string): string | undefined {
  const aggregatorUrl = process.env.WALRUS_AGGREGATOR_URL?.trim();

  if (!aggregatorUrl) {
    return undefined;
  }

  return `${trimSlash(aggregatorUrl)}/v1/blobs/${encodeURIComponent(blobId)}`;
}

/** Number of Walrus epochs to persist blobs for. Defaults to 5 so durable recall
 * survives well beyond a single epoch (the publisher default). */
function getWalrusEpochs() {
  const parsed = Number(process.env.WALRUS_EPOCHS);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 5;
}

class LocalWalrusClient implements WalrusClient {
  async storeEnvelope(envelope: SealEnvelope): Promise<WalrusStoreResult> {
    const body = stableStringify(envelope);
    const walrusBlobId = shortId("walrus", body);
    const walrusObjectId = `0x${contentHash(`${walrusBlobId}:object`).slice(2, 66)}`;
    const dir = getLocalWalrusDir();
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${walrusBlobId}.json`), body);

    return {
      walrusBlobId,
      walrusObjectId,
      suiTxDigest: `local-${contentHash(`${walrusBlobId}:tx`).slice(2, 18)}`,
    };
  }

  async readEnvelope(blobId: string): Promise<SealEnvelope> {
    const body = await readFile(path.join(getLocalWalrusDir(), `${blobId}.json`), "utf8");
    return JSON.parse(body) as SealEnvelope;
  }
}

class HttpWalrusClient implements WalrusClient {
  constructor(
    private readonly publisherUrl: string,
    private readonly aggregatorUrl: string,
    private readonly epochs: number,
    private readonly timeoutMs = getWalrusTimeoutMs()
  ) {}

  async storeEnvelope(envelope: SealEnvelope): Promise<WalrusStoreResult> {
    const body = stableStringify(envelope);
    const response = await fetchWithTimeout(
      `${trimSlash(this.publisherUrl)}/v1/blobs?epochs=${this.epochs}`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body,
      },
      this.timeoutMs,
      "Walrus publisher"
    );

    if (!response.ok) {
      throw new Error(`Walrus publisher returned ${response.status}.`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const created = readRecord(payload.newlyCreated) ?? readRecord(payload.alreadyCertified);
    const blobObject = readRecord(created?.blobObject);
    const resourceOperation = readRecord(created?.resourceOperation);
    const walrusBlobId =
      readString(created?.blobId) ||
      readString(blobObject?.blobId) ||
      shortId("walrus", body);
    const walrusObjectId =
      readString(blobObject?.id) ||
      readString(blobObject?.objectId) ||
      `0x${contentHash(`${walrusBlobId}:object`).slice(2, 66)}`;

    return {
      walrusBlobId,
      walrusObjectId,
      suiTxDigest: readString(resourceOperation?.txDigest),
    };
  }

  async readEnvelope(blobId: string): Promise<SealEnvelope> {
    const response = await fetchWithTimeout(
      `${trimSlash(this.aggregatorUrl)}/v1/blobs/${encodeURIComponent(blobId)}`,
      undefined,
      this.timeoutMs,
      "Walrus aggregator"
    );

    if (!response.ok) {
      throw new Error(`Walrus aggregator returned ${response.status}.`);
    }

    return (await response.json()) as SealEnvelope;
  }
}

function getLocalWalrusDir() {
  return path.resolve(
    process.cwd(),
    process.env.WALRUS_LOCAL_STORE_DIR?.trim() ||
      process.env.LANGCLAW_LOCAL_STATE_DIR?.trim() ||
      ".langclaw-state/walrus"
  );
}

function getWalrusTimeoutMs() {
  const parsed = Number(process.env.WALRUS_TIMEOUT_MS);

  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 60_000;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  label: string
) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }

    throw error;
  }
}

function isTimeoutError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "TimeoutError" || error.name === "AbortError";
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
