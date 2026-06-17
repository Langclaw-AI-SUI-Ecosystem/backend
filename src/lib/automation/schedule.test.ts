import assert from "node:assert/strict";
import test from "node:test";

import { buildTriggerLabel, computeNextRunAt } from "./schedule";

test("computes the next daily run in the configured timezone", () => {
  assert.equal(
    computeNextRunAt({
      frequency: "daily",
      from: new Date("2026-05-15T03:30:00.000Z"),
      scheduleTime: "09:00",
      timezone: "Asia/Jakarta",
    }),
    "2026-05-16T02:00:00.000Z"
  );
});

test("computes the current day daily run when the time is still ahead", () => {
  assert.equal(
    computeNextRunAt({
      frequency: "daily",
      from: new Date("2026-05-15T00:30:00.000Z"),
      scheduleTime: "09:00",
      timezone: "Asia/Jakarta",
    }),
    "2026-05-15T02:00:00.000Z"
  );
});

test("computes the next weekly run on the requested weekday", () => {
  assert.equal(
    computeNextRunAt({
      frequency: "weekly",
      from: new Date("2026-05-15T03:00:00.000Z"),
      scheduleTime: "08:30",
      scheduleWeekday: 5,
      timezone: "Asia/Jakarta",
    }),
    "2026-05-22T01:30:00.000Z"
  );
});

test("computes the next monthly run and clamps short months", () => {
  assert.equal(
    computeNextRunAt({
      frequency: "monthly",
      from: new Date("2026-02-01T00:00:00.000Z"),
      scheduleMonthDay: 31,
      scheduleTime: "10:00",
      timezone: "Asia/Jakarta",
    }),
    "2026-02-28T03:00:00.000Z"
  );
});

test("builds readable trigger labels", () => {
  assert.equal(
    buildTriggerLabel({
      scheduleFrequency: "weekly",
      scheduleTime: "08:30",
      scheduleWeekday: 5,
      triggerType: "schedule",
    }),
    "Every Friday at 08:30"
  );
  assert.equal(
    buildTriggerLabel({
      eventName: "benchmark completes",
      triggerType: "event",
    }),
    "After benchmark completes"
  );
});
