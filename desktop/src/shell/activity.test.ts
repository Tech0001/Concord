import assert from "node:assert/strict";
import test from "node:test";
import { activitySummary } from "./activity.ts";

const q = (o: Partial<Parameters<typeof activitySummary>[0] & object> = {}) => ({
  running: true, active: 0, queued: 0, retry: 0, waitingLive: 0, failed: 0, dailyDownloads: 0, dailyLimit: 0, atDailyLimit: false, activeKind: null, ...o,
});

test("the sidebar says what the queue is doing in a few words", () => {
  assert.deepEqual(activitySummary(q({ active: 1, activeKind: "transcribe", queued: 4 })), { detail: "Transcribing · 4 waiting", tone: "busy" });
  assert.deepEqual(activitySummary(q({ active: 1, activeKind: "download" })), { detail: "Downloading", tone: "busy" });
  assert.deepEqual(activitySummary(q({ running: false, queued: 2, retry: 1 })), { detail: "Paused · 3 waiting", tone: "paused" });
  assert.deepEqual(activitySummary(q({ queued: 2 })), { detail: "2 waiting", tone: "wait" });
  assert.deepEqual(activitySummary(q({ failed: 1 })), { detail: "1 needs attention", tone: "bad" });
  assert.deepEqual(activitySummary(q({ failed: 2 })), { detail: "2 need attention", tone: "bad" });
  assert.deepEqual(activitySummary(q({ running: false })), { detail: "Paused", tone: "paused" });
  assert.deepEqual(activitySummary(q()), { detail: "Up to date", tone: "idle" });
  assert.deepEqual(activitySummary(undefined), { detail: "", tone: "idle" });
});
