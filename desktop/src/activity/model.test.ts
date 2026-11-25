import assert from "node:assert/strict";
import test from "node:test";
import { activityHeadline, jobLine } from "./model.ts";

const NOW = 1_800_000_000;
const job = (o: Partial<Parameters<typeof jobLine>[0]>) => ({ status: "queued", kind: "transcribe", path: "/r/a.m4a", message: "", retry_at: 0, ...o });

test("each queue item says what it is doing or waiting for", () => {
  assert.deepEqual(jobLine(job({ status: "running", kind: "download", path: null, message: "45.2% · 3.1MiB/s" }), NOW), { label: "Downloading · 45%", pct: 45 });
  assert.deepEqual(jobLine(job({ status: "running", message: "Transcribing" }), NOW), { label: "Transcribing", pct: null });
  assert.deepEqual(jobLine(job({ status: "running", message: "Identifying speakers 30%" }), NOW), { label: "Transcribing · 30%", pct: 30 });
  assert.deepEqual(jobLine(job({ kind: "download", path: null }), NOW), { label: "Waiting to download", pct: null });
  assert.deepEqual(jobLine(job({}), NOW), { label: "Waiting to transcribe", pct: null });
  assert.deepEqual(jobLine(job({ message: "Waiting for the speech engine to finish installing" }), NOW), { label: "Waiting for the speech engine", pct: null });
  assert.deepEqual(jobLine(job({ status: "retry", retry_at: NOW + 600 }), NOW), { label: "Retrying in 10 minutes", pct: null });
  assert.deepEqual(jobLine(job({ status: "retry", retry_at: NOW - 5 }), NOW), { label: "Retrying shortly", pct: null });
  assert.deepEqual(jobLine(job({ status: "waiting_live" }), NOW), { label: "Waiting for the live stream to end", pct: null });
});

test("the Activity headline counts what is running, next and stuck", () => {
  const q = { running: true, active: 2, queued: 2, retry: 1, waitingLive: 0, failed: 1, dailyDownloads: 0, dailyLimit: 0, atDailyLimit: false };
  assert.equal(activityHeadline(q), "2 running · 3 up next · 1 needs attention");
  assert.equal(activityHeadline({ ...q, active: 0, queued: 0, retry: 0, failed: 2 }), "2 need attention");
  assert.equal(activityHeadline({ ...q, active: 0, queued: 0, retry: 0, failed: 0 }), "Nothing to do right now");
  assert.equal(activityHeadline({ ...q, running: false }), "Paused · nothing new starts until you resume");
});
