import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  enqueueVideo,
  enqueueVideos,
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
import {
  buildArchiveHealthReport,
  cleanOrphanedDerivedIndexes,
  createDatabaseBackup,
  duplicateEntriesFor,
  fingerprintMedia,
  validateBackupFile,
} from "./archive-maintenance";
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

test("local files are deduplicated by channel and source URL when a mount change alters their id", () => {
  const sourceUrl = "file:///run/media/pc/Maac/YouTube/audio/meetings/example.m4a";
  assert.equal(enqueueVideo({
    videoId: "legacy-path-hash",
    channelId: "meetings",
    title: "Existing meeting",
    url: sourceUrl,
  }), true);

  assert.equal(enqueueVideo({
    videoId: "new-path-hash",
    channelId: "meetings",
    title: "Existing meeting",
    url: sourceUrl,
  }), false);
  assert.equal(enqueueVideos([{
    videoId: "another-path-hash",
    channelId: "meetings",
    title: "Existing meeting",
    url: sourceUrl,
  }]), 0);

  const row = getDb().prepare(
    "SELECT count(*) AS count FROM video_queue WHERE channel_id = ? AND url = ?",
  ).get("meetings", sourceUrl) as { count: number };
  assert.equal(row.count, 1);
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
  const queueColumns = getDb().prepare("PRAGMA table_info(video_queue)").all() as { name: string }[];
  assert.ok(queueColumns.some(column => column.name === "media_fingerprint"));
  assert.ok(queueColumns.some(column => column.name === "source_checked_at"));
});

test("archive health reports missing local files without mutating source records", () => {
  const report = buildArchiveHealthReport("test-embedding-model");
  assert.equal(report.expectedEmbeddingDimensions, 1024);
  assert.ok(report.issues.some(issue => issue.id === "missing-media" && issue.count >= 1));
  assert.ok(report.issues.some(issue => issue.id === "missing-transcripts"));
});

test("derived cleanup removes orphan virtual-table rows without touching valid sources", () => {
  const db = getDb();
  const vector = JSON.stringify(Array(1024).fill(0));
  db.prepare(`
    INSERT INTO vec_segments
      (embedding, video_id, channel_id, segment_index, model, text, start_seconds, end_seconds, speaker)
    VALUES (?, 'orphan-video', 'orphan-channel', ?, 'test-model', 'orphan vector', ?, ?, NULL)
  `).run(vector, 0n, 0, 1);
  db.prepare(`
    INSERT INTO vec_segments
      (embedding, video_id, channel_id, segment_index, model, text, start_seconds, end_seconds, speaker)
    VALUES (?, 'video', 'channel', ?, 'test-model', 'valid vector', ?, ?, NULL)
  `).run(vector, 0n, 0, 1);
  db.prepare(`
    INSERT INTO transcript_segments_fts
      (video_id, channel_id, segment_index, start_seconds, end_seconds, speaker, text)
    VALUES ('orphan-video', 'orphan-channel', 0, 0, 1, NULL, 'orphan keyword row')
  `).run();
  db.prepare(`
    INSERT INTO transcript_index (video_id, channel_id, md_path, md_mtime_ms, segment_count)
    VALUES ('orphan-video', 'orphan-channel', '/missing.md', 0, 1)
  `).run();

  const result = cleanOrphanedDerivedIndexes();
  assert.equal(result.vectorRows, 1);
  assert.equal(result.keywordRows, 1);
  assert.equal(result.transcriptIndexes, 1);
  assert.equal(result.removed, 3);
  assert.equal((db.prepare("SELECT COUNT(*) AS count FROM vec_segments WHERE video_id = 'video' AND channel_id = 'channel'").get() as { count: number }).count, 1);
});

test("media fingerprints detect same bytes stored under different records", () => {
  const media = path.join(tempDir, "same-recording.mp3");
  fs.writeFileSync(media, Buffer.from("same media bytes for duplicate audit"));
  add("duplicate-one", "Duplicate one", media);
  add("duplicate-two", "Duplicate two", media);
  const first = getQueueEntry("duplicate-one", "channel");
  const second = getQueueEntry("duplicate-two", "channel");
  assert.ok(first && second);
  const a = fingerprintMedia(first);
  const b = fingerprintMedia(second);
  assert.equal(a?.fingerprint, b?.fingerprint);
  assert.equal(duplicateEntriesFor(a?.fingerprint || null).length, 2);
});

test("database backups are consistent and independently validated", async () => {
  const folder = path.join(tempDir, "backups");
  const backup = await createDatabaseBackup(folder);
  assert.ok(fs.existsSync(backup.path));
  const validated = validateBackupFile(backup.path);
  assert.equal(validated.ok, true);
  assert.ok(validated.videos >= 2);
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
