import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeAlphaWatchlistMetadataInput,
  WatchlistHttpError,
} from "./watchlist";

const now = new Date("2026-06-20T08:00:00.000Z");

test("watchlist metadata normalizes notes and priority", () => {
  assert.deepEqual(
    normalizeAlphaWatchlistMetadataInput(
      { note: "  Accumulation thesis\nwith follow-up.  ", priority: "high" },
      now
    ),
    {
      note: "Accumulation thesis\nwith follow-up.",
      priority: "high",
    }
  );

  assert.deepEqual(
    normalizeAlphaWatchlistMetadataInput({ note: "" }, now),
    { note: null }
  );
});

test("watchlist reviewed status records review time and clears snooze", () => {
  assert.deepEqual(
    normalizeAlphaWatchlistMetadataInput({ status: "reviewed" }, now),
    {
      reviewed_at: now.toISOString(),
      snoozed_until: null,
      status: "reviewed",
    }
  );

  assert.deepEqual(
    normalizeAlphaWatchlistMetadataInput({ status: "watching" }, now),
    {
      reviewed_at: null,
      snoozed_until: null,
      status: "watching",
    }
  );
});

test("watchlist snooze defaults to one day and accepts a future time", () => {
  assert.deepEqual(
    normalizeAlphaWatchlistMetadataInput({ status: "snoozed" }, now),
    {
      reviewed_at: null,
      snoozed_until: "2026-06-21T08:00:00.000Z",
      status: "snoozed",
    }
  );

  assert.deepEqual(
    normalizeAlphaWatchlistMetadataInput(
      { snoozedUntil: "2026-06-27T08:00:00.000Z", status: "snoozed" },
      now
    ),
    {
      reviewed_at: null,
      snoozed_until: "2026-06-27T08:00:00.000Z",
      status: "snoozed",
    }
  );
});

test("watchlist metadata rejects invalid status and snooze input", () => {
  assert.throws(
    () => normalizeAlphaWatchlistMetadataInput({ status: "archived" }, now),
    WatchlistHttpError
  );
  assert.throws(
    () =>
      normalizeAlphaWatchlistMetadataInput(
        { snoozedUntil: "2026-06-19T08:00:00.000Z", status: "snoozed" },
        now
      ),
    /future/
  );
  assert.throws(
    () =>
      normalizeAlphaWatchlistMetadataInput(
        { snoozedUntil: "2026-06-27T08:00:00.000Z" },
        now
      ),
    /requires the snoozed status/
  );
});
