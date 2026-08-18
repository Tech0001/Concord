import { nanoid } from "nanoid";
import { assertEmbeddingModelDimensions } from "./llm";
import { embedSegmentsForVideo } from "./embed-segments";
import { summarizeVideo } from "./summarize-video";
import { embedDocument } from "./docs-embed";
import { embedNote, listNoteIds } from "./note-embeddings";
import { listDocuments } from "./docs-index";
import {
  EMBEDDING_DIM,
  clearAllEmbeddings,
  getCoveredVideoKeysForModel,
  getDb,
  getQueueList,
  setVideoAiSummary,
} from "./db";

export type BackgroundJobType = "segment_embeddings" | "doc_embeddings" | "note_embeddings" | "video_summaries";
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

  enqueue(type: BackgroundJobType, options: { model: string; overwrite?: boolean; wipe?: boolean }): BackgroundJob {
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
        const covered = new Set(getCoveredVideoKeysForModel(options.model).map(key => `${key.videoId}|${key.channelId}`));
        items = videos.filter(key => !covered.has(`${key.videoId}|${key.channelId}`));
      }
      label = "Transcript semantic index";
    } else if (type === "doc_embeddings") {
      items = listDocuments().map(doc => doc.id);
      label = "Document semantic index";
    } else if (type === "note_embeddings") {
      items = listNoteIds();
      label = "Research note semantic index";
    } else {
      items = allVideos();
      label = "AI summary backfill";
    }

    const id = nanoid();
    const payload: JobPayload = {
      model: options.model,
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
      if (job.type !== "video_summaries") {
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
          } else {
            const key = item as VideoKey;
            if (payload.overwrite) setVideoAiSummary(key.videoId, key.channelId, null, null);
            const out = await summarizeVideo(key.videoId, key.channelId, payload.model);
            if (out.skipped) result.skipped += 1;
            else { result.written += 1; result.units += out.charsOut; }
          }
        } catch (error) {
          result.failed += 1;
          if (result.errors.length < 10) {
            result.errors.push({ item: itemLabel(item), error: error instanceof Error ? error.message : String(error) });
          }
        }

        payload = { ...payload, cursor: index + 1 };
        db.prepare(`
          UPDATE background_jobs
          SET payload = ?, progress_done = ?, result = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(JSON.stringify(payload), index + 1, JSON.stringify(result), job.id);
      }

      db.prepare(`
        UPDATE background_jobs
        SET status = 'completed', progress_done = progress_total,
            result = ?, completed_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(JSON.stringify(result), job.id);
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
