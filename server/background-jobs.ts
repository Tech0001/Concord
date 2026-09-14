import { nanoid } from "nanoid";
import { assertEmbeddingModelDimensions } from "./llm";
import { embedSegmentsForVideo } from "./embed-segments";
import { summarizeVideo } from "./summarize-video";
import { embedDocument } from "./docs-embed";
import { embedNote, listNoteIds } from "./note-embeddings";
import { listDocuments } from "./docs-index";
import { ensureLibraryThumbnail, libraryThumbnailCachePath } from "./library-thumbnails";
import { cleanOrphanedDerivedIndexesInWorker, fingerprintMedia } from "./archive-maintenance";
import fs from "fs";
import {
  EMBEDDING_DIM,
  clearAllEmbeddings,
  getCoveredVideoKeysForModel,
  getDb,
  getQueueEntry,
  getQueueList,
  setVideoAiSummary,
} from "./db";

export type BackgroundJobType =
  | "segment_embeddings"
  | "doc_embeddings"
  | "note_embeddings"
  | "video_summaries"
  | "thumbnail_backfill"
  | "media_fingerprints"
  | "derived_index_cleanup";
export type BackgroundJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

interface VideoKey { videoId: string; channelId: string }

interface JobPayload {
  model: string;
  cursor: number;
  overwrite?: boolean;
  wipe?: boolean;
  wipeApplied?: boolean;
  items: Array<string | VideoKey>;
}

interface JobResult {
  written: number;
  skipped: number;
  failed: number;
  units: number;
  errors: { item: string; error: string }[];
}

export interface BackgroundJob {
  id: string;
  type: BackgroundJobType;
  status: BackgroundJobStatus;
  label: string;
  payload: JobPayload;
  progress_done: number;
  progress_total: number;
  result: JobResult | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface RawJob extends Omit<BackgroundJob, "payload" | "result" | "cancel_requested"> {
  payload: string;
  result: string | null;
  cancel_requested: number;
}

function parseJob(row: RawJob): BackgroundJob {
  return {
    ...row,
    payload: JSON.parse(row.payload) as JobPayload,
    result: row.result ? JSON.parse(row.result) as JobResult : null,
    cancel_requested: !!row.cancel_requested,
  };
}

function emptyResult(): JobResult {
  return { written: 0, skipped: 0, failed: 0, units: 0, errors: [] };
}

function itemLabel(item: string | VideoKey): string {
  return typeof item === "string" ? item : `${item.channelId}:${item.videoId}`;
}

class BackgroundJobManager {
  private working = false;
  private stopping = false;

  start(): void {
    // A process exit can strand a row in running. Work is item-idempotent and
    // cursor-based, so put it back in the queue and resume at its last commit.
    getDb().prepare(`
      UPDATE background_jobs
      SET status = 'queued', updated_at = datetime('now')
      WHERE status = 'running'
    `).run();
    this.schedule();
  }

  stop(): void {
    this.stopping = true;
  }

  list(limit = 100): BackgroundJob[] {
    return (getDb().prepare(`
      SELECT * FROM background_jobs
      ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
               created_at DESC
      LIMIT ?
    `).all(Math.max(1, Math.min(limit, 250))) as RawJob[]).map(parseJob);
  }

  get(id: string): BackgroundJob | undefined {
    const row = getDb().prepare("SELECT * FROM background_jobs WHERE id = ?").get(id) as RawJob | undefined;
    return row ? parseJob(row) : undefined;
  }

  enqueue(type: BackgroundJobType, options: { model?: string; overwrite?: boolean; wipe?: boolean }): BackgroundJob {
    const active = getDb().prepare(`
      SELECT * FROM background_jobs
      WHERE type = ? AND status IN ('queued', 'running')
      ORDER BY created_at LIMIT 1
    `).get(type) as RawJob | undefined;
    if (active) return parseJob(active);

    const allVideos = () => getQueueList({ status: "complete", limit: 100000 }).rows
      .map(row => ({ videoId: row.video_id, channelId: row.channel_id }));
    let items: Array<string | VideoKey>;
    let label: string;
    if (type === "segment_embeddings") {
      const videos = allVideos();
      if (options.wipe) {
        items = videos;
      } else {
        const covered = new Set(getCoveredVideoKeysForModel(options.model || "").map(key => `${key.videoId}|${key.channelId}`));
        items = videos.filter(key => !covered.has(`${key.videoId}|${key.channelId}`));
      }
      label = "Transcript semantic index";
    } else if (type === "doc_embeddings") {
      items = listDocuments().map(doc => doc.id);
      label = "Document semantic index";
    } else if (type === "note_embeddings") {
      items = listNoteIds();
      label = "Research note semantic index";
    } else if (type === "video_summaries") {
      items = allVideos();
      label = "AI summary backfill";
    } else if (type === "thumbnail_backfill") {
      items = allVideos().filter(key => {
        const entry = getQueueEntry(key.videoId, key.channelId);
        return !!entry?.video_path && !/\.(mp3|m4a|wav|flac|aac|opus|ogg)$/i.test(entry.video_path)
          && !fs.existsSync(libraryThumbnailCachePath(entry));
      });
      label = "Library thumbnail repair";
    } else if (type === "derived_index_cleanup") {
      items = ["derived-indexes"];
      label = "Derived search index cleanup";
    } else {
      items = allVideos().filter(key => {
        const entry = getQueueEntry(key.videoId, key.channelId);
        return !!entry?.video_path && fs.existsSync(entry.video_path) && !entry.media_fingerprint;
      });
      label = "Media duplicate fingerprints";
    }

    const id = nanoid();
    const payload: JobPayload = {
      model: options.model || "local",
      cursor: 0,
      overwrite: !!options.overwrite,
      wipe: !!options.wipe,
      wipeApplied: false,
      items,
    };
    getDb().prepare(`
      INSERT INTO background_jobs (id, type, status, label, payload, progress_total, result)
      VALUES (?, ?, 'queued', ?, ?, ?, ?)
    `).run(id, type, label, JSON.stringify(payload), items.length, JSON.stringify(emptyResult()));
    this.schedule();
    return this.get(id)!;
  }

  cancel(id: string): BackgroundJob | undefined {
    getDb().prepare(`
      UPDATE background_jobs
      SET cancel_requested = 1, updated_at = datetime('now')
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(id);
    this.schedule();
    return this.get(id);
  }

  retry(id: string): BackgroundJob | undefined {
    getDb().prepare(`
      UPDATE background_jobs
      SET status = 'queued', cancel_requested = 0, error = NULL,
          completed_at = NULL, updated_at = datetime('now')
      WHERE id = ? AND status IN ('failed', 'cancelled')
    `).run(id);
    this.schedule();
    return this.get(id);
  }

  retryFailures(id: string): BackgroundJob | undefined {
    const job = this.get(id);
    const failed = job?.result?.errors || [];
    if (!job || failed.length === 0 || job.status === "running" || job.status === "queued") return undefined;
    const items: Array<string | VideoKey> = failed.map(failure => {
      if (job.type === "segment_embeddings" || job.type === "video_summaries" || job.type === "thumbnail_backfill" || job.type === "media_fingerprints") {
        const colon = failure.item.indexOf(":");
        return colon > 0
          ? { channelId: failure.item.slice(0, colon), videoId: failure.item.slice(colon + 1) }
          : failure.item;
      }
      return failure.item;
    });
    const payload: JobPayload = { ...job.payload, cursor: 0, wipe: false, wipeApplied: false, items };
    getDb().prepare(`
      UPDATE background_jobs
      SET status = 'queued', payload = ?, progress_done = 0, progress_total = ?,
          result = ?, error = NULL, cancel_requested = 0, started_at = NULL,
          completed_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(payload), items.length, JSON.stringify(emptyResult()), id);
    this.schedule();
    return this.get(id);
  }

  private schedule(): void {
    if (this.working || this.stopping) return;
    setImmediate(() => void this.work());
  }

  private async work(): Promise<void> {
    if (this.working || this.stopping) return;
    this.working = true;
    try {
      while (!this.stopping) {
        const raw = getDb().prepare(`
          SELECT * FROM background_jobs WHERE status = 'queued'
          ORDER BY created_at LIMIT 1
        `).get() as RawJob | undefined;
        if (!raw) break;
        await this.run(parseJob(raw));
      }
    } finally {
      this.working = false;
      if (!this.stopping) {
        const more = getDb().prepare("SELECT 1 FROM background_jobs WHERE status = 'queued' LIMIT 1").get();
        if (more) this.schedule();
      }
    }
  }

  private async run(job: BackgroundJob): Promise<void> {
    const db = getDb();
    db.prepare(`
      UPDATE background_jobs
      SET status = 'running', started_at = COALESCE(started_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(job.id);

    let payload = job.payload;
    let result = job.result ?? emptyResult();
    try {
      if (payload.items.length === 0) {
        db.prepare(`
          UPDATE background_jobs SET status = 'completed', completed_at = datetime('now'),
            updated_at = datetime('now'), result = ? WHERE id = ?
        `).run(JSON.stringify(result), job.id);
        return;
      }
      if (job.type === "segment_embeddings" || job.type === "doc_embeddings" || job.type === "note_embeddings") {
        // Repeat on resume: cheap, and guarantees the model still matches the
        // fixed vec schema before any destructive wipe or paid batch call.
        await assertEmbeddingModelDimensions(payload.model, EMBEDDING_DIM);
      }

      if (job.type === "segment_embeddings" && payload.wipe && !payload.wipeApplied) {
        payload = { ...payload, wipeApplied: true };
        db.transaction(() => {
          clearAllEmbeddings(payload.model);
          db.prepare("UPDATE background_jobs SET payload = ?, updated_at = datetime('now') WHERE id = ?")
            .run(JSON.stringify(payload), job.id);
        })();
      }

      for (let index = payload.cursor; index < payload.items.length; index++) {
        const cancel = db.prepare("SELECT cancel_requested FROM background_jobs WHERE id = ?").get(job.id) as { cancel_requested: number } | undefined;
        if (cancel?.cancel_requested) {
          db.prepare(`
            UPDATE background_jobs SET status = 'cancelled', completed_at = datetime('now'),
              updated_at = datetime('now'), result = ? WHERE id = ?
          `).run(JSON.stringify(result), job.id);
          return;
        }

        const item = payload.items[index];
        try {
          if (job.type === "segment_embeddings") {
            const key = item as VideoKey;
            const out = await embedSegmentsForVideo(key.videoId, key.channelId, payload.model);
            if (out.skipped) result.skipped += 1;
            else { result.written += 1; result.units += out.segmentCount; }
          } else if (job.type === "doc_embeddings") {
            const out = await embedDocument(item as string, { model: payload.model, skipIfPresent: !payload.overwrite });
            if (out.error) throw new Error(out.error);
            if (out.embedded > 0) { result.written += 1; result.units += out.embedded; }
            else result.skipped += 1;
          } else if (job.type === "note_embeddings") {
            const out = await embedNote(item as string, { model: payload.model, skipIfPresent: !payload.overwrite });
            if (out.error) throw new Error(out.error);
            if (out.embedded > 0) { result.written += 1; result.units += out.embedded; }
            else result.skipped += 1;
          } else if (job.type === "video_summaries") {
            const key = item as VideoKey;
            if (payload.overwrite) setVideoAiSummary(key.videoId, key.channelId, null, null);
            const out = await summarizeVideo(key.videoId, key.channelId, payload.model);
            if (out.skipped) result.skipped += 1;
            else { result.written += 1; result.units += out.charsOut; }
          } else if (job.type === "thumbnail_backfill") {
            const key = item as VideoKey;
            const entry = getQueueEntry(key.videoId, key.channelId);
            if (!entry) throw new Error("Library item no longer exists");
            const output = await ensureLibraryThumbnail(entry);
            if (!output) throw new Error("No source artwork or usable video frame was available");
            result.written += 1;
            result.units += 1;
          } else if (job.type === "derived_index_cleanup") {
            const output = await cleanOrphanedDerivedIndexesInWorker();
            result.written += 1;
            result.units += output.removed;
          } else {
            const key = item as VideoKey;
            const entry = getQueueEntry(key.videoId, key.channelId);
            if (!entry) throw new Error("Library item no longer exists");
            const output = fingerprintMedia(entry);
            if (!output) throw new Error("Media file is unavailable");
            result.written += 1;
            result.units += output.bytes;
          }
        } catch (error) {
          result.failed += 1;
          result.errors.push({ item: itemLabel(item), error: error instanceof Error ? error.message : String(error) });
        }

        payload = { ...payload, cursor: index + 1 };
        db.prepare(`
          UPDATE background_jobs
          SET payload = ?, progress_done = ?, result = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(JSON.stringify(payload), index + 1, JSON.stringify(result), job.id);
      }

      const whollyFailed = result.failed > 0 && result.written === 0 && result.skipped === 0;
      db.prepare(`
        UPDATE background_jobs
        SET status = ?, progress_done = progress_total, error = ?,
            result = ?, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(
        whollyFailed ? "failed" : "completed",
        whollyFailed ? result.errors[0]?.error || "Every item failed" : null,
        JSON.stringify(result),
        job.id,
      );
    } catch (error) {
      db.prepare(`
        UPDATE background_jobs
        SET status = 'failed', error = ?, result = ?, completed_at = datetime('now'),
            updated_at = datetime('now') WHERE id = ?
      `).run(error instanceof Error ? error.message : String(error), JSON.stringify(result), job.id);
    }
  }
}

export const backgroundJobs = new BackgroundJobManager();
