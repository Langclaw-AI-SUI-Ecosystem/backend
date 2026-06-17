import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { jsonResponse, mockFetch, withEnv } from "../test/helpers";
import { runPrivateMemoryWorkflow } from "./memory-workflow";
import { decryptPrivateMemory } from "./seal";
import { createWalrusClient } from "./walrus";
import type { DiscoverPayload } from "./langclaw/types";

const OWNER = `0x${"ab".repeat(32)}`;
const OTHER_OWNER = `0x${"cd".repeat(32)}`;

function makePayload(topic: string): DiscoverPayload {
  return {
    topic,
    generatedAt: new Date().toISOString(),
    sources: [
      {
        id: "s1",
        type: "docs_page",
        title: "Doc",
        url: "https://example.test/doc",
        excerpt: "excerpt",
        provider: "Tavily",
      },
    ],
    errors: [],
    providerTrace: [
      { provider: "tavily", status: "success", scope: "topic", message: "ok" },
    ],
    finalConclusion: {
      headline: "Headline",
      summary: `Prior summary about ${topic}.`,
      keySignals: [{ label: "L", text: "T", sourceIds: [] }],
      recommendation: "Keep monitoring.",
      qualityNote: "",
      generatedBy: "Final Conclusion Agent",
    },
    finalAnswer: {
      answer: "Answer",
      bullets: ["b1", "b2"],
      recommendation: "Keep monitoring.",
      generatedBy: "Final Conclusion Agent",
    },
    finalAnswerMeta: { synthesis: "deterministic-fallback" },
    agentOutputs: {
      planner: { plan: 1 },
      trend: { trend: 2 },
      evidence: { evidence: 3 },
      verifier: { verifier: 4 },
    },
  } as unknown as DiscoverPayload;
}

function runner(captureContext: (context: unknown[]) => void) {
  return (async (topic: string, options?: { context?: unknown[] }) => {
    captureContext(options?.context ?? []);
    return makePayload(topic);
  }) as unknown as NonNullable<
    Parameters<typeof runPrivateMemoryWorkflow>[1]
  >["runResearch"];
}

test("stores an encrypted Walrus memory and metadata-only proof on the first run", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-mem-"));

  try {
    await withEnv({ LANGCLAW_LOCAL_STATE_DIR: dir }, async () => {
      let context: unknown[] = [];
      const run = await runPrivateMemoryWorkflow(
        { topic: "Sui liquid staking risk", ownerAddress: OWNER },
        { runResearch: runner((value) => (context = value)) }
      );

      assert.equal(context.length, 0, "no prior memory exists on the first run");
      assert.equal(run.walrusMemory?.storageStatus, "uploaded");
      assert.ok(run.walrusMemory?.walrusBlobId);
      assert.match(run.walrusMemory?.contentHash ?? "", /^0x/);
      assert.equal(run.walrusMemory?.sealMode, "local-envelope");
      assert.equal(run.walrusMemory?.registryStatus, "skipped");
      assert.equal(run.walrusMemory?.memWalStatus, "skipped");
      assert.equal(run.walrusMemory?.agentPipeline?.length, 1);
      assert.equal(run.walrusMemory?.agentPipeline?.[0]?.role, "agent-pipeline");
      // Verifiable round trip: the stored blob is re-fetched and hash-checked.
      assert.equal(run.walrusMemory?.retrievalStatus, "retrieved");
      assert.equal(run.walrusMemory?.hashVerified, true);
      assert.equal(run.walrusMemory?.walrusStorageMode, "local");
      assert.equal(
        run.walrusMemory?.walrusBlobUrl,
        undefined,
        "local fallback exposes no public blob URL"
      );
      assert.deepEqual(run.reusedMemories, []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("degrades gracefully when the Walrus publisher fails — research is never discarded", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-mem-"));

  try {
    await withEnv(
      {
        LANGCLAW_LOCAL_STATE_DIR: dir,
        // Force HTTP mode pointed at a refused endpoint so storeEnvelope throws.
        WALRUS_PUBLISHER_URL: "http://127.0.0.1:1",
        WALRUS_AGGREGATOR_URL: "http://127.0.0.1:1",
      },
      async () => {
        const run = await runPrivateMemoryWorkflow(
          { topic: "Walrus publisher outage", ownerAddress: OWNER },
          { runResearch: runner(() => undefined) }
        );

        // The completed (expensive) research run is preserved and the proof
        // honestly reports the storage failure instead of throwing.
        assert.ok(run.walrusMemory, "research payload + proof still returned");
        assert.equal(run.walrusMemory?.storageStatus, "failed");
        assert.equal(run.walrusMemory?.retrievalStatus, "failed");
        assert.equal(run.walrusMemory?.hashVerified, false);
        assert.equal(run.walrusMemory?.walrusStorageMode, "http");
        assert.equal(
          run.walrusMemory?.walrusBlobUrl,
          undefined,
          "no public blob URL when storage failed"
        );
        // No dangling pointer is anchored when the blob never landed.
        assert.equal(run.walrusMemory?.registryStatus, "skipped");
        assert.equal(run.walrusMemory?.memWalStatus, "skipped");
        assert.ok(
          run.walrusMemory?.storageReason,
          "a storage failure reason is reported"
        );
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stores compact research memory instead of raw provider payloads", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-mem-"));

  try {
    await withEnv(
      {
        LANGCLAW_LOCAL_STATE_DIR: dir,
        SUI_REGISTRY_ENABLED: "false",
        WALRUS_AGGREGATOR_URL: undefined,
        WALRUS_PUBLISHER_URL: undefined,
      },
      async () => {
        const hugeProviderPayload = "x".repeat(100_000);
        const payload = {
          ...makePayload("Sui large provider payload"),
          onChain: {
            answer: "On-chain answer",
            bullets: [],
            caveat: "Caveat",
            generatedAt: new Date().toISOString(),
            plan: {
              analysisSource: "prompt",
              chain: "sui",
              chainId: 101,
              chainName: "Sui",
              commands: [],
              domainCount: 1,
              intent: "smart_money",
              nativeSymbol: "SUI",
              productChain: "sui-testnet",
              productChainId: 101,
              productChainName: "Sui Testnet",
              registryCommandCount: 1,
            },
            recommendation: "Keep monitoring.",
            title: "Sui watch",
            tools: [
              {
                commandId: "dune.sui_accumulation_flow",
                data: { hugeProviderPayload },
                domain: "smart_money",
                latencyMs: 1,
                provider: "dune",
                status: "success",
                summary: "Dune returned Sui DEX and CEX address context rows.",
                title: "Sui accumulation flow",
              },
            ],
          },
        } as unknown as DiscoverPayload;

        const run = await runPrivateMemoryWorkflow(
          { topic: payload.topic, ownerAddress: OWNER },
          { runResearch: (async () => payload) as NonNullable<
            Parameters<typeof runPrivateMemoryWorkflow>[1]
          >["runResearch"] }
        );
        const blobId = run.walrusMemory?.walrusBlobId;

        assert.ok(blobId, "memory blob should be stored");

        const envelope = await createWalrusClient().readEnvelope(blobId);
        const artifact = await decryptPrivateMemory(envelope, OWNER);
        const artifactJson = JSON.stringify(artifact);

        assert.equal(artifactJson.includes(hugeProviderPayload), false);
        assert.match(artifactJson, /Dune returned Sui DEX and CEX address context rows/);
        assert.match(artifactJson, /object keys: hugeProviderPayload/);
        assert.ok(artifactJson.length < 30_000, "memory artifact should stay compact");
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prioritizes the main Walrus memory blob when handoff storage is slow", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-mem-"));
  let putCount = 0;
  let storedEnvelope: unknown;
  const restore = mockFetch((url, init) => {
    if (url.includes("/v1/blobs") && init?.method === "PUT") {
      putCount += 1;

      if (putCount === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("The operation was aborted due to timeout");
              error.name = "TimeoutError";
              reject(error);
            },
            { once: true }
          );
        });
      }

      storedEnvelope =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;

      return jsonResponse({
        newlyCreated: {
          blobObject: {
            id: `0x${"12".repeat(32)}`,
            blobId: "main-memory-blob",
          },
          resourceOperation: {
            txDigest: "main-memory-tx",
          },
        },
      });
    }

    if (url.includes("/v1/blobs/main-memory-blob")) {
      return jsonResponse(storedEnvelope);
    }

    throw new Error(`Unexpected fetch: ${url}`);
  });

  try {
    await withEnv(
      {
        LANGCLAW_LOCAL_STATE_DIR: dir,
        PRIVATE_MEMORY_ANCILLARY_TIMEOUT_MS: "5",
        PRIVATE_MEMORY_STORAGE_TIMEOUT_MS: "500",
        WALRUS_AGGREGATOR_URL: "https://aggregator.example.test",
        WALRUS_PUBLISHER_URL: "https://publisher.example.test",
        WALRUS_TIMEOUT_MS: "100",
      },
      async () => {
        const run = await runPrivateMemoryWorkflow(
          { topic: "Walrus handoff delay", ownerAddress: OWNER },
          { runResearch: runner(() => undefined) }
        );

        assert.equal(run.walrusMemory?.storageStatus, "uploaded");
        assert.equal(run.walrusMemory?.walrusBlobId, "main-memory-blob");
        assert.equal(run.walrusMemory?.retrievalStatus, "retrieved");
        assert.equal(run.walrusMemory?.hashVerified, true);
        assert.deepEqual(run.walrusMemory?.agentPipeline, []);
      }
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("times out when the Walrus publisher never responds", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-mem-"));
  const restore = mockFetch((_url, init) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const abort = () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        reject(error);
      };

      if (signal?.aborted) {
        abort();
        return;
      }

      signal?.addEventListener("abort", abort, { once: true });
    });
  });

  try {
    await withEnv(
      {
        LANGCLAW_LOCAL_STATE_DIR: dir,
        WALRUS_AGGREGATOR_URL: "https://aggregator.example.test",
        WALRUS_PUBLISHER_URL: "https://publisher.example.test",
        WALRUS_TIMEOUT_MS: "5",
      },
      async () => {
        const run = await runPrivateMemoryWorkflow(
          { topic: "Walrus timeout", ownerAddress: OWNER },
          { runResearch: runner(() => undefined) }
        );

        assert.equal(run.walrusMemory?.storageStatus, "failed");
        assert.equal(run.walrusMemory?.retrievalStatus, "failed");
        assert.match(
          run.walrusMemory?.storageReason ?? "",
          /Walrus publisher timed out after 5ms/
        );
      }
    );
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recalls and reuses a prior memory on a related run for the same owner", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-mem-"));

  try {
    await withEnv({ LANGCLAW_LOCAL_STATE_DIR: dir }, async () => {
      await runPrivateMemoryWorkflow(
        { topic: "Sui liquid staking risk", ownerAddress: OWNER },
        { runResearch: runner(() => undefined) }
      );

      let context: unknown[] = [];
      const run2 = await runPrivateMemoryWorkflow(
        { topic: "Sui staking yield and liquid staking", ownerAddress: OWNER },
        { runResearch: runner((value) => (context = value)) }
      );

      assert.ok(
        context.length >= 1,
        "prior memory should be injected into the research context"
      );
      assert.ok((run2.reusedMemories?.length ?? 0) >= 1);
      assert.ok((run2.walrusMemory?.reusedMemoryIds.length ?? 0) >= 1);
      // Multi-agent loop closed: the prior run's handoff blobs were re-fetched
      // and decrypted straight from Walrus, not just written.
      assert.ok(
        (run2.walrusMemory?.reusedHandoffBlobIds.length ?? 0) >= 1,
        "prior agent handoffs should be recalled from Walrus"
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("owner isolation: a different wallet recalls nothing (privacy invariant)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "langclaw-mem-"));

  try {
    await withEnv({ LANGCLAW_LOCAL_STATE_DIR: dir }, async () => {
      await runPrivateMemoryWorkflow(
        { topic: "Sui liquid staking risk", ownerAddress: OWNER },
        { runResearch: runner(() => undefined) }
      );

      let context: unknown[] = [];
      await runPrivateMemoryWorkflow(
        { topic: "Sui liquid staking risk", ownerAddress: OTHER_OWNER },
        { runResearch: runner((value) => (context = value)) }
      );

      assert.equal(context.length, 0, "another wallet must not recall this owner's memory");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
