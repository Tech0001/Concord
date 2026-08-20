import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enqueueVideo,
  getDb,
  getQueueEntry,
  getQueueList,
  setVideoPlaybackProgress,
  setVideoReviewState,
  upsertVideoOverviewNote,
} from "./db";
import { backgroundJobs } from "./background-jobs";
import { libraryThumbnailCachePath } from "./library-thumbnails";
import { sendLibraryThumbnailFile } from "./routes-library";
import type { Response } from "express";

// Include a dot-prefixed path component to match Linux's ~/.local app-data
// directory and catch Express's default hidden-file rejection.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), ".concord-library-test-"));
getDb(path.join(tempDir, "library.sqlite"));

function add(id: string, title: string, filePath: string, opts: { live?: boolean; thumbnail?: string } = {}) {
  enqueueVideo({
    videoId: id,
    channelId: "channel",
    title,
    url: `https://example.test/${id}`,
    isLive: opts.live,
    thumbnailUrl: opts.thumbnail,
  });
  getDb().prepare("UPDATE video_queue SET video_path = ?, status = 'complete' WHERE video_id = ?").run(filePath, id);
}

test("library media/review filters distinguish audio, video, and live records", () => {
  add("audio", "Audio recording", "/archive/talk.mp3");
  add("video", "Video recording", "/archive/talk.mp4", { thumbnail: "https://img.test/video.jpg" });
  add("live", "Live recording", "/archive/live.mp4", { live: true });

  setVideoReviewState("video", "channel", "in_review");

  assert.deepEqual(getQueueList({ type: "audio" }).rows.map(row => row.video_id), ["audio"]);
  assert.deepEqual(getQueueList({ type: "video" }).rows.map(row => row.video_id), ["video"]);
  assert.deepEqual(getQueueList({ type: "live" }).rows.map(row => row.video_id), ["live"]);
  assert.deepEqual(getQueueList({ reviewState: "in_review" }).rows.map(row => row.video_id), ["video"]);
  assert.equal(getQueueEntry("video", "channel")?.thumbnail_url, "https://img.test/video.jpg");
});

test("playback progress persists and recently-viewed sorting uses it", () => {
  setVideoPlaybackProgress("audio", "channel", 72.5);
  assert.equal(getQueueEntry("audio", "channel")?.last_position_seconds, 72.5);

  getDb().prepare("UPDATE video_queue SET last_opened_at = ? WHERE video_id = ?").run("2026-01-01 00:00:00", "audio");
  getDb().prepare("UPDATE video_queue SET last_opened_at = ? WHERE video_id = ?").run("2026-02-01 00:00:00", "video");
  assert.equal(getQueueList({ sort: "recently_viewed" }).rows[0]?.video_id, "video");
});

test("whole-video observations become one reusable research note", () => {
  const created = upsertVideoOverviewNote("video", "channel", "First observation");
  assert.equal(created.note, "First observation");
  assert.equal(created.anchors.length, 1);
  assert.equal(created.anchors[0]?.video_id, "video");
  assert.equal(getQueueEntry("video", "channel")?.overview_note_id, created.id);

  const updated = upsertVideoOverviewNote("video", "channel", "Revised observation");
  assert.equal(updated.id, created.id);
  assert.equal(updated.note, "Revised observation");
  assert.equal(getQueueEntry("video", "channel")?.notes, "Revised observation");
});

test("cached thumbnails are served from a dot-prefixed app-data path", async () => {
  const entry = getQueueEntry("video", "channel");
  assert.ok(entry);
  const thumbnail = libraryThumbnailCachePath(entry);
  fs.mkdirSync(path.dirname(thumbnail), { recursive: true });
  fs.writeFileSync(thumbnail, Buffer.alloc(256, 0xff));
  assert.ok(thumbnail.includes("/.concord-library-test-"));

  let contentType = "";
  let sentPath = "";
  let dotfiles = "";
  const response = {
    type(value: string) {
      contentType = value;
      return response;
    },
    sendFile(value: string, options: { dotfiles?: string }) {
      sentPath = value;
      dotfiles = options.dotfiles || "";
      return response;
    },
  } as unknown as Response;
  sendLibraryThumbnailFile(response, thumbnail);
  assert.equal(contentType, "image/jpeg");
  assert.equal(sentPath, thumbnail);
  assert.equal(dotfiles, "allow");
});

test("durable jobs and note citation columns are present after migration", () => {
  const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE name IN ('background_jobs', 'vec_notes') ORDER BY name").all() as { name: string }[];
  assert.deepEqual(tables.map(row => row.name), ["background_jobs", "vec_notes"]);
  const sourceColumns = getDb().prepare("PRAGMA table_info(chat_message_sources)").all() as { name: string }[];
  assert.ok(sourceColumns.some(column => column.name === "note_id"));
});

test("a job stranded as running is resumed from persistent state", async () => {
  getDb().prepare(`
    INSERT INTO background_jobs
      (id, type, status, label, payload, progress_total, result)
    VALUES (?, 'note_embeddings', 'running', 'Recovery test', ?, 0, ?)
  `).run(
    "recovery-test",
    JSON.stringify({ model: "unused", cursor: 0, items: [] }),
    JSON.stringify({ written: 0, skipped: 0, failed: 0, units: 0, errors: [] }),
  );
  backgroundJobs.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(backgroundJobs.get("recovery-test")?.status, "completed");
  backgroundJobs.stop();
});
