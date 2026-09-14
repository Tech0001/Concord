import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import type { Pipeline } from "./pipeline";
import {
  EMBEDDING_DIM,
  getDb,
  getQueueEntry,
  refreshTranscriptSearchIndex,
  setConfigValues,
} from "./db";
import { assertEmbeddingModelDimensions } from "./llm";
import { EmbeddingDimensionMismatchError } from "./embedding-dimensions";
import { backgroundJobs } from "./background-jobs";
import {
  buildArchiveHealthReport,
  createDatabaseBackup,
  duplicateEntriesFor,
  ensureWaveform,
  fingerprintMedia,
  inferSourceKind,
  stageDatabaseRestore,
  validateBackupFile,
} from "./archive-maintenance";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}

/** Reliability + cross-source research endpoints. These are grouped because
 * they operate across library domains rather than owning a single source
 * type (videos/docs/notes). */
export function registerResearchRoutes(app: Express, pipeline: Pipeline): void {
  app.get("/api/archive-health", (_req, res) => {
    try {
      const model = pipeline.getConfig().llm.embeddingModel || null;
      res.setHeader("Cache-Control", "no-store");
      res.json(buildArchiveHealthReport(model));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Archive audit failed" });
    }
  });

  app.post("/api/archive-health/check-embedding-model", async (_req, res) => {
    const model = pipeline.getConfig().llm.embeddingModel;
    if (!model) return res.status(400).json({ error: "No embedding model configured" });
    try {
      await assertEmbeddingModelDimensions(model, EMBEDDING_DIM);
      const checkedAt = new Date().toISOString();
      setConfigValues({
        "health.lastEmbeddingDimensionCheck": JSON.stringify({ model, dimensions: EMBEDDING_DIM, checkedAt }),
      });
      res.json({ ok: true, model, dimensions: EMBEDDING_DIM, checkedAt });
    } catch (error) {
      if (error instanceof EmbeddingDimensionMismatchError) {
        return res.status(409).json({
          error: error.message,
          model: error.model,
          actualDimensions: error.actualDimensions,
          expectedDimensions: error.expectedDimensions,
        });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : "Dimension check failed" });
    }
  });

  app.post("/api/archive-health/repair", (req, res) => {
    const action = String(req.body?.action || "");
    const model = pipeline.getConfig().llm.embeddingModel || "";
    try {
      if (action === "reindex-transcripts") {
        return res.json({ ok: true, action, result: refreshTranscriptSearchIndex() });
      }
      if (action === "clean-derived-indexes") {
        return res.status(202).json({ ok: true, action, job: backgroundJobs.enqueue("derived_index_cleanup", {}) });
      }
      if (action === "thumbnails") {
        return res.status(202).json({ ok: true, action, job: backgroundJobs.enqueue("thumbnail_backfill", {}) });
      }
      if (action === "fingerprints") {
        return res.status(202).json({ ok: true, action, job: backgroundJobs.enqueue("media_fingerprints", {}) });
      }
      if (action === "segment-embeddings" || action === "doc-embeddings") {
        if (!model) return res.status(400).json({ error: "No embedding model configured" });
        const type = action === "segment-embeddings" ? "segment_embeddings" : "doc_embeddings";
        return res.status(202).json({ ok: true, action, job: backgroundJobs.enqueue(type, { model }) });
      }
      res.status(400).json({ error: "Unknown or unsafe repair action" });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Repair failed" });
    }
  });

  app.post("/api/backups", async (req, res) => {
    const folder = String(req.body?.folder || "").trim();
    if (!folder) return res.status(400).json({ error: "Backup folder is required" });
    try {
      res.json({ ok: true, backup: await createDatabaseBackup(folder) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Backup failed" });
    }
  });

  app.post("/api/backups/validate", (req, res) => {
    const file = String(req.body?.file || "").trim();
    if (!file) return res.status(400).json({ error: "Backup file is required" });
    try { res.json(validateBackupFile(file)); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Invalid backup" }); }
  });

  app.post("/api/backups/restore", (req, res) => {
    const file = String(req.body?.file || "").trim();
    const confirmed = req.body?.confirmed === true;
    if (!file) return res.status(400).json({ error: "Backup file is required" });
    if (!confirmed) return res.status(400).json({ error: "Restore confirmation is required" });
    try { res.json({ ok: true, ...stageDatabaseRestore(file) }); }
    catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : "Restore staging failed" }); }
  });

  app.get("/api/command/search", (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const like = `%${escapeLike(q)}%`;
      const db = getDb();
      const queryLimit = Math.max(1, Math.min(10, Number(req.query.limit) || 6));
      const videoRows = db.prepare(`
        SELECT v.video_id, v.channel_id, v.title, v.upload_date, c.name AS channel_name
        FROM video_queue v LEFT JOIN channels c ON c.id = v.channel_id
        WHERE (? = '' OR v.title LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')
        ORDER BY COALESCE(v.last_opened_at, v.updated_at) DESC LIMIT ?
      `).all(q, like, like, queryLimit) as { video_id: string; channel_id: string; title: string; upload_date: string | null; channel_name: string | null }[];
      const docRows = db.prepare(`
        SELECT id, title, rel_path, root_id FROM documents
        WHERE (? = '' OR title LIKE ? ESCAPE '\\' OR rel_path LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC LIMIT ?
      `).all(q, like, like, queryLimit) as { id: string; title: string; rel_path: string; root_id: string | null }[];
      const noteRows = db.prepare(`
        SELECT id, title, note FROM transcript_clips
        WHERE (? = '' OR title LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR quote LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC LIMIT ?
      `).all(q, like, like, like, queryLimit) as { id: string; title: string; note: string | null }[];
      const speakerRows = db.prepare(`
        SELECT id, name, notes FROM speakers
        WHERE is_noise = 0 AND (? = '' OR name LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')
        ORDER BY updated_at DESC LIMIT ?
      `).all(q, like, like, queryLimit) as { id: string; name: string; notes: string | null }[];
      const chatRows = db.prepare(`
        SELECT id, title, updated_at FROM chat_conversations
        WHERE (? = '' OR title LIKE ? ESCAPE '\\')
        ORDER BY pinned DESC, updated_at DESC LIMIT ?
      `).all(q, like, queryLimit) as { id: string; title: string | null; updated_at: string }[];

      res.setHeader("Cache-Control", "no-store");
      res.json({
        results: [
          ...videoRows.map(row => ({ id: `video:${row.channel_id}:${row.video_id}`, type: "video", title: row.title, subtitle: row.channel_name || row.upload_date || "Library", href: `/library?video=${encodeURIComponent(row.video_id)}&channel=${encodeURIComponent(row.channel_id)}`, source: { kind: "video", videoId: row.video_id, channelId: row.channel_id, title: row.title } })),
          ...docRows.map(row => ({ id: `doc:${row.id}`, type: "doc", title: row.title, subtitle: row.rel_path, href: `/docs?path=${encodeURIComponent(row.rel_path)}&rootId=${encodeURIComponent(row.root_id || "")}`, source: { kind: "doc", documentId: row.id, rootId: row.root_id || "", relPath: row.rel_path, title: row.title } })),
          ...noteRows.map(row => ({ id: `note:${row.id}`, type: "note", title: row.title, subtitle: row.note?.slice(0, 100) || "Research note", href: `/notes?noteId=${encodeURIComponent(row.id)}`, source: { kind: "note", noteId: row.id, title: row.title } })),
          ...speakerRows.map(row => ({ id: `speaker:${row.id}`, type: "speaker", title: row.name, subtitle: row.notes?.slice(0, 100) || "Speaker", href: `/speakers?speakerId=${encodeURIComponent(row.id)}` })),
          ...chatRows.map(row => ({ id: `chat:${row.id}`, type: "chat", title: row.title || "Untitled chat", subtitle: "AI conversation", href: `/ai?conversationId=${encodeURIComponent(row.id)}` })),
        ],
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Command search failed" });
    }
  });

  app.get("/api/videos/library/:channelId/:videoId/provenance", (req: Request<{ channelId: string; videoId: string }>, res) => {
    const entry = getQueueEntry(req.params.videoId, req.params.channelId);
    if (!entry) return res.status(404).json({ error: "Library item not found" });
    const duplicates = duplicateEntriesFor(entry.media_fingerprint)
      .filter(other => other.video_id !== entry.video_id || other.channel_id !== entry.channel_id)
      .map(other => ({ videoId: other.video_id, channelId: other.channel_id, title: other.title, path: other.video_path, importedAt: other.created_at }));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      provenance: {
        sourceKind: entry.source_kind || inferSourceKind(entry),
        sourceUrl: entry.url || null,
        importedAt: entry.created_at,
        checkedAt: entry.source_checked_at,
        sourceAvailable: entry.source_available == null ? null : !!entry.source_available,
        mediaPath: entry.video_path,
        transcriptPath: entry.md_path,
        fingerprint: entry.media_fingerprint,
        bytes: entry.media_bytes,
        duplicates,
      },
    });
  });

  app.post("/api/videos/library/:channelId/:videoId/fingerprint", (req: Request<{ channelId: string; videoId: string }>, res) => {
    const entry = getQueueEntry(req.params.videoId, req.params.channelId);
    if (!entry) return res.status(404).json({ error: "Library item not found" });
    try {
      const result = fingerprintMedia(entry);
      if (!result) return res.status(404).json({ error: "Media file is unavailable" });
      res.json({ ok: true, ...result, duplicates: duplicateEntriesFor(result.fingerprint).length - 1 });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Fingerprint failed" });
    }
  });

  app.post("/api/videos/library/:channelId/:videoId/verify-source", async (req: Request<{ channelId: string; videoId: string }>, res) => {
    const entry = getQueueEntry(req.params.videoId, req.params.channelId);
    if (!entry) return res.status(404).json({ error: "Library item not found" });
    const checkedAt = new Date().toISOString();
    let available = false;
    let detail = "No original URL recorded";
    try {
      if (/^file:/i.test(entry.url || "")) {
        const filePath = decodeURIComponent(new URL(entry.url).pathname);
        available = fs.existsSync(filePath);
        detail = available ? "Original local file is available" : "Original local file is missing";
      } else if (/^https?:/i.test(entry.url || "")) {
        const response = await fetch(entry.url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10_000) });
        available = response.ok;
        detail = `Source returned HTTP ${response.status}`;
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : "Source check failed";
    }
    getDb().prepare(`
      UPDATE video_queue SET source_checked_at = ?, source_available = ?, source_kind = ?
      WHERE video_id = ? AND channel_id = ?
    `).run(checkedAt, available ? 1 : 0, inferSourceKind(entry), entry.video_id, entry.channel_id);
    res.json({ ok: true, available, checkedAt, detail });
  });

  app.get("/api/videos/library/:channelId/:videoId/waveform", async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
    const entry = getQueueEntry(req.params.videoId, req.params.channelId);
    if (!entry) return res.status(404).end();
    try {
      const waveform = await ensureWaveform(entry);
      if (!waveform) return res.status(404).end();
      res.type("image/png").sendFile(path.resolve(waveform), { dotfiles: "allow" });
    } catch {
      res.status(404).end();
    }
  });
}
