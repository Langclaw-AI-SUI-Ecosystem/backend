import assert from "node:assert/strict";
import test from "node:test";

import { buildMemoryStats, type MemoryItem } from "./memory";

const baseMemory: MemoryItem = {
  category: "Project",
  confidence: 90,
  id: "memory-1",
  lastUsed: "2026-06-19",
  memory: "Track Sui liquidity",
  scope: "Langclaw",
  source: "Chat",
  status: "active",
  updatedAt: "2026-06-19",
};

test("memory stats report recall notes and verifiable Walrus records separately", () => {
  const stats = buildMemoryStats(
    [
      baseMemory,
      {
        ...baseMemory,
        id: "memory-2",
        scope: "Global",
        status: "disabled",
      },
    ],
    7
  );

  assert.deepEqual(stats, {
    active: 1,
    disabled: 1,
    projectScoped: 1,
    total: 2,
    verifiable: 7,
  });
});
