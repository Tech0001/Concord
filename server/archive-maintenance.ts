import crypto from "crypto";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { spawn } from "child_process";
import { createRequire } from "module";
import { Worker } from "worker_threads";
import { ffmpegBin } from "./audio";
import { EMBEDDING_DIM, getCoveredVideoKeysForModel, getDb, type QueueEntry, videoKind } from "./db";
import { listRoots } from "./docs-index";
import { libraryThumbnailCachePath } from "./library-thumbnails";
import { trackChildProcess } from "./child-process-registry";

export type HealthSeverity = "error" | "warning" | "info";

export interface HealthItem {
  id: string;
  title: string;
  detail?: string;
  href?: string;
}

export interface HealthIssue {
  id: string;
  category: "storage" | "transcripts" | "thumbnails" | "embeddings" | "notes" | "jobs" | "duplicates";
  severity: HealthSeverity;
  title: string;
  description: string;
  count: number;
  items: HealthItem[];
  repairAction?: "reindex-transcripts" | "thumbnails" | "segment-embeddings" | "doc-embeddings" | "clean-derived-indexes" | "fingerprints";
}

export interface ArchiveHealthReport {
  generatedAt: string;
  expectedEmbeddingDimensions: number;
  activeEmbeddingModel: string | null;
  lastDimensionCheck: { model: string; dimensions: number; checkedAt: string } | null;
  summary: { errors: number; warnings: number; healthy: boolean };
  issues: HealthIssue[];
  storage: { databasePath: string; databaseBytes: number; mediaBytes: number; roots: { path: string; available: boolean }[] };
}

function existsFile(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function limited<T>(rows: T[], limit = 75): T[] {
  return rows.slice(0, limit);
}

function videoHref(row: Pick<QueueEntry, "video_id" | "channel_id">): string {
  return `/library?video=${encodeURIComponent(row.video_id)}&channel=${encodeURIComponent(row.channel_id)}`;
}

function parseDimensionCheck(raw: string | undefined): ArchiveHealthReport["lastDimensionCheck"] {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.model === "string" && Number.isFinite(value.dimensions) && typeof value.checkedAt === "string") {
      return value;
    }
  } catch { /* stale config is treated as no check */ }
  return null;
}

/** Local-only archive audit. It deliberately never probes source URLs or the
 * embedding server: opening Health must be cheap, private, and predictable.
 * Network/model verification is an explicit user action. */
export function buildArchiveHealthReport(activeEmbeddingModel: string | null): ArchiveHealthReport {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM video_queue ORDER BY updated_at DESC").all() as QueueEntry[];
  const issues: HealthIssue[] = [];
  const sourceVideoKeys = new Set(rows.map(row => `${row.channel_id}\0${row.video_id}`));
  const sourceDocIds = new Set((db.prepare("SELECT id FROM documents").all() as { id: string }[]).map(row => row.id));
  let embeddedVideoKeys = new Set<string>();
  let embeddedDocIds = new Set<string>();

  const missingMedia = rows.filter(row => !!row.video_path && !existsFile(row.video_path));
  if (missingMedia.length) issues.push({
    id: "missing-media", category: "storage", severity: "error",
    title: "Missing media files",
    description: "The database remembers these items, but their media path is unavailable. Reconnect the drive or relink each item.",
    count: missingMedia.length,
    items: limited(missingMedia).map(row => ({ id: `${row.channel_id}:${row.video_id}`, title: row.title, detail: row.video_path || "", href: videoHref(row) })),
  });

  const missingTranscripts = rows.filter(row => row.status === "complete" && (!row.md_path || !existsFile(row.md_path)));
  if (missingTranscripts.length) issues.push({
    id: "missing-transcripts", category: "transcripts", severity: "error",
    title: "Missing transcripts",
    description: "Completed media should have a readable transcript file. These items need retranscription or relinking.",
    count: missingTranscripts.length,
    items: limited(missingTranscripts).map(row => ({ id: `${row.channel_id}:${row.video_id}`, title: row.title, detail: row.md_path || "No transcript path", href: videoHref(row) })),
  });

  const videoRows = rows.filter(row => videoKind(row.video_path) === "video" && existsFile(row.video_path));
  const missingThumbnails = videoRows.filter(row => !existsFile(libraryThumbnailCachePath(row)));
  if (missingThumbnails.length) issues.push({
    id: "missing-thumbnails", category: "thumbnails", severity: "warning",
    title: "Missing cached thumbnails",
    description: "These videos can be repaired in the background from source artwork or a generated video frame.",
    count: missingThumbnails.length,
    repairAction: "thumbnails",
    items: limited(missingThumbnails).map(row => ({ id: `${row.channel_id}:${row.video_id}`, title: row.title, href: videoHref(row) })),
  });

  const staleFts = rows.filter(row => {
    if (!row.md_path || !existsFile(row.md_path)) return false;
    const indexed = db.prepare("SELECT md_mtime_ms FROM transcript_index WHERE video_id = ? AND channel_id = ?")
      .get(row.video_id, row.channel_id) as { md_mtime_ms: number } | undefined;
    if (!indexed) return true;
    try { return Math.abs(indexed.md_mtime_ms - fs.statSync(row.md_path).mtimeMs) > 1; } catch { return true; }
  });
  if (staleFts.length) issues.push({
    id: "stale-transcript-index", category: "transcripts", severity: "warning",
    title: "Stale transcript search index",
    description: "Transcript files changed or have not reached full-text search yet.",
    count: staleFts.length, repairAction: "reindex-transcripts",
    items: limited(staleFts).map(row => ({ id: `${row.channel_id}:${row.video_id}`, title: row.title, href: videoHref(row) })),
  });

  if (activeEmbeddingModel) {
    // vec0 auxiliary columns do not optimize correlated NOT EXISTS checks.
    // Running one DISTINCT scan and comparing the ~600 source keys in JS is
    // several orders of magnitude faster on large transcript archives.
    embeddedVideoKeys = new Set(
      getCoveredVideoKeysForModel(activeEmbeddingModel)
        .map(key => `${key.channelId}\0${key.videoId}`),
    );
    const missingEmbeddings = rows.filter(row =>
      row.status === "complete" && !!row.md_path && existsFile(row.md_path)
      && !embeddedVideoKeys.has(`${row.channel_id}\0${row.video_id}`),
    );
    if (missingEmbeddings.length) issues.push({
      id: "stale-segment-embeddings", category: "embeddings", severity: "warning",
      title: "Videos missing semantic embeddings",
      description: `These transcripts are not searchable in the active ${activeEmbeddingModel} vector space. A dimension check runs before repair.`,
      count: missingEmbeddings.length, repairAction: "segment-embeddings",
      items: limited(missingEmbeddings).map(row => ({ id: `${row.channel_id}:${row.video_id}`, title: row.title, href: videoHref(row) })),
    });

    embeddedDocIds = new Set((db.prepare(`
      SELECT DISTINCT document_id FROM vec_docs WHERE model = ?
    `).all(activeEmbeddingModel) as { document_id: string }[]).map(row => row.document_id));
    const keywordDocIds = new Set((db.prepare(`
      SELECT DISTINCT document_id FROM docs_fts
    `).all() as { document_id: string }[]).map(row => row.document_id));
    const missingDocEmbeddings = (db.prepare(`
      SELECT id, title, rel_path, COALESCE(root_id, '') AS root_id
      FROM documents ORDER BY updated_at DESC
    `).all() as { id: string; title: string; rel_path: string; root_id: string }[])
      .filter(row => keywordDocIds.has(row.id) && !embeddedDocIds.has(row.id));
    if (missingDocEmbeddings.length) issues.push({
      id: "stale-doc-embeddings", category: "embeddings", severity: "warning",
      title: "Documents missing semantic embeddings",
      description: "Keyword search still works, but these documents are absent from semantic retrieval.",
      count: missingDocEmbeddings.length, repairAction: "doc-embeddings",
      items: limited(missingDocEmbeddings).map(row => ({ id: row.id, title: row.title, detail: row.rel_path, href: `/docs?path=${encodeURIComponent(row.rel_path)}&rootId=${encodeURIComponent(row.root_id)}` })),
    });
  }

  const rootStates = listRoots().map(root => ({ path: root.path, available: fs.existsSync(root.path) }));
  const missingRoots = rootStates.filter(root => !root.available);
  if (missingRoots.length) issues.push({
    id: "missing-doc-roots", category: "storage", severity: "error",
    title: "Disconnected document roots",
    description: "One or more configured document folders cannot be reached.",
    count: missingRoots.length,
    items: missingRoots.map(root => ({ id: root.path, title: path.basename(root.path) || root.path, detail: root.path })),
  });

  const orphanAnchors = db.prepare(`
    SELECT a.clip_id, a.ordinal, c.title,
           CASE WHEN a.document_id IS NOT NULL THEN a.document_id ELSE a.channel_id || ':' || a.video_id END AS source_key
    FROM note_anchors a
    JOIN transcript_clips c ON c.id = a.clip_id
    WHERE (a.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = a.document_id))
       OR (a.video_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM video_queue vq WHERE vq.video_id = a.video_id AND vq.channel_id = a.channel_id
          ))
  `).all() as { clip_id: string; ordinal: number; title: string; source_key: string }[];
  if (orphanAnchors.length) issues.push({
    id: "orphan-note-anchors", category: "notes", severity: "warning",
    title: "Notes anchored to unavailable sources",
    description: "The notes are preserved, but their original evidence record is no longer in the library.",
    count: orphanAnchors.length,
    items: limited(orphanAnchors).map(row => ({ id: `${row.clip_id}:${row.ordinal}`, title: row.title, detail: row.source_key, href: `/notes?noteId=${encodeURIComponent(row.clip_id)}` })),
  });

  // Count orphaned source groups, not every derived segment. Reuse the
  // single vector scans above; never run a per-vector correlated subquery.
  const orphanTranscriptIndex = (db.prepare("SELECT video_id, channel_id FROM transcript_index").all() as { video_id: string; channel_id: string }[])
    .filter(row => !sourceVideoKeys.has(`${row.channel_id}\0${row.video_id}`)).length;
  const orphanDerived = orphanTranscriptIndex
    + Array.from(embeddedVideoKeys).filter(key => !sourceVideoKeys.has(key)).length
    + Array.from(embeddedDocIds).filter(id => !sourceDocIds.has(id)).length;
  if (orphanDerived) issues.push({
    id: "orphan-derived-indexes", category: "embeddings", severity: "info",
    title: "Orphaned derived index sources",
    description: "Safe-to-rebuild search data remains for sources that were removed. User notes and source files are not affected by cleanup.",
    count: orphanDerived, repairAction: "clean-derived-indexes", items: [],
  });

  const failedRows = rows.filter(row => row.status === "failed" || !!row.error);
  const failedJobItems = (db.prepare(`
    SELECT COALESCE(SUM(CAST(json_extract(result, '$.failed') AS INTEGER)), 0) AS count
    FROM background_jobs
  `).get() as { count: number }).count;
  if (failedRows.length || failedJobItems) issues.push({
    id: "failed-work", category: "jobs", severity: "warning",
    title: "Failed archive work",
    description: "Review the individual errors and retry only the failed items from the jobs panel.",
    count: failedRows.length + failedJobItems,
    items: limited(failedRows).map(row => ({ id: `${row.channel_id}:${row.video_id}`, title: row.title, detail: row.error || row.status, href: videoHref(row) })),
  });

  const duplicateGroups = db.prepare(`
    SELECT media_fingerprint, COUNT(*) AS count
    FROM video_queue WHERE media_fingerprint IS NOT NULL AND media_fingerprint <> ''
    GROUP BY media_fingerprint HAVING COUNT(*) > 1
  `).all() as { media_fingerprint: string; count: number }[];
  const duplicateCount = duplicateGroups.reduce((sum, group) => sum + group.count, 0);
  const unhashed = rows.filter(row => existsFile(row.video_path) && !row.media_fingerprint);
  if (duplicateCount || unhashed.length) issues.push({
    id: "duplicate-audit", category: "duplicates", severity: duplicateCount ? "warning" : "info",
    title: duplicateCount ? "Possible duplicate recordings" : "Duplicate scan incomplete",
    description: duplicateCount
      ? `${duplicateCount} items share an on-disk content fingerprint. Review provenance before removing anything.`
      : "Fingerprint existing media to detect the same recording stored under different names.",
    count: duplicateCount || unhashed.length, repairAction: "fingerprints", items: [],
  });

  let mediaBytes = 0;
  for (const row of rows) {
    if (row.media_bytes) mediaBytes += row.media_bytes;
    else if (existsFile(row.video_path)) {
      try { mediaBytes += fs.statSync(row.video_path!).size; } catch { /* raced with a drive */ }
    }
  }
  const errors = issues.filter(issue => issue.severity === "error").reduce((sum, issue) => sum + issue.count, 0);
  const warnings = issues.filter(issue => issue.severity === "warning").reduce((sum, issue) => sum + issue.count, 0);
  const config = Object.fromEntries((db.prepare("SELECT key, value FROM app_config").all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
  let databaseBytes = 0;
  try { databaseBytes = fs.statSync(db.name).size; } catch { /* in-memory tests */ }
  return {
    generatedAt: new Date().toISOString(),
    expectedEmbeddingDimensions: EMBEDDING_DIM,
    activeEmbeddingModel,
    lastDimensionCheck: parseDimensionCheck(config["health.lastEmbeddingDimensionCheck"]),
    summary: { errors, warnings, healthy: errors === 0 && warnings === 0 },
    issues,
    storage: { databasePath: db.name, databaseBytes, mediaBytes, roots: rootStates },
  };
}

/** Fast content identity: file size plus the first and last MiB. It avoids
 * reading multi-gigabyte videos while still being stable across renames and
 * overwhelmingly unlikely to collide for real media. */
export function fingerprintMedia(entry: QueueEntry): { fingerprint: string; bytes: number } | null {
  if (!entry.video_path || !existsFile(entry.video_path)) return null;
  const stat = fs.statSync(entry.video_path);
  const sampleSize = Math.min(1024 * 1024, stat.size);
  const first = Buffer.alloc(sampleSize);
  const last = Buffer.alloc(sampleSize);
  const fd = fs.openSync(entry.video_path, "r");
  try {
    fs.readSync(fd, first, 0, sampleSize, 0);
    fs.readSync(fd, last, 0, sampleSize, Math.max(0, stat.size - sampleSize));
  } finally {
    fs.closeSync(fd);
  }
  const fingerprint = crypto.createHash("sha256")
    .update(String(stat.size)).update("\0").update(first).update(last).digest("hex");
  getDb().prepare(`
    UPDATE video_queue SET media_fingerprint = ?, media_bytes = ?, updated_at = updated_at
    WHERE video_id = ? AND channel_id = ?
  `).run(fingerprint, stat.size, entry.video_id, entry.channel_id);
  return { fingerprint, bytes: stat.size };
}

export function duplicateEntriesFor(fingerprint: string | null): QueueEntry[] {
  if (!fingerprint) return [];
  return getDb().prepare(`
    SELECT * FROM video_queue WHERE media_fingerprint = ? ORDER BY created_at
  `).all(fingerprint) as QueueEntry[];
}

export function inferSourceKind(entry: Pick<QueueEntry, "url" | "channel_id">): string {
  if (/youtube\.com|youtu\.be/i.test(entry.url || "")) return "YouTube";
  if (/^file:/i.test(entry.url || "")) return /voice/i.test(entry.channel_id) ? "Voice note" : "Local file";
  if (/^https?:/i.test(entry.url || "")) return "Web import";
  return /voice/i.test(entry.channel_id) ? "Voice note" : "Local import";
}

export interface DerivedIndexCleanupResult {
  removed: number;
  vectorRows: number;
  keywordRows: number;
  transcriptIndexes: number;
}

/** Remove search/index rows whose source record no longer exists.
 *
 * sqlite-vec auxiliary columns are filterable, but they are not indexed for
 * ordinary DELETE statements. Deleting one source with
 * `WHERE video_id = ? AND channel_id = ?` therefore scans the entire vector
 * table; repeating that for several sources can pin the Node event loop for
 * minutes. Scan each virtual table once, retain only orphan rowids, then use
 * sqlite-vec/FTS's efficient rowid delete path. Derived data does not require
 * all-or-nothing cleanup, so small transactions also avoid one enormous WAL
 * commit when an old archive has accumulated many stale chunks. */
function cleanOrphanedDerivedIndexesWithDb(db: Database.Database): DerivedIndexCleanupResult {
  const sourceVideoKeys = new Set((db.prepare("SELECT video_id, channel_id FROM video_queue").all() as { video_id: string; channel_id: string }[])
    .map(row => `${row.channel_id}\0${row.video_id}`));
  const sourceDocIds = new Set((db.prepare("SELECT id FROM documents").all() as { id: string }[]).map(row => row.id));
  const orphanVectorVideoRowIds: number[] = [];
  const orphanVectorDocRowIds: number[] = [];
  const orphanFtsVideoRowIds: number[] = [];
  const orphanFtsDocRowIds: number[] = [];

  const vectorVideoRows = db.prepare("SELECT rowid, video_id, channel_id FROM vec_segments")
    .iterate()[Symbol.iterator]() as Iterator<{ rowid: number; video_id: string; channel_id: string }>;
  for (let next = vectorVideoRows.next(); !next.done; next = vectorVideoRows.next()) {
    const row = next.value;
    if (!sourceVideoKeys.has(`${row.channel_id}\0${row.video_id}`)) orphanVectorVideoRowIds.push(row.rowid);
  }
  const vectorDocRows = db.prepare("SELECT rowid, document_id FROM vec_docs")
    .iterate()[Symbol.iterator]() as Iterator<{ rowid: number; document_id: string }>;
  for (let next = vectorDocRows.next(); !next.done; next = vectorDocRows.next()) {
    const row = next.value;
    if (!sourceDocIds.has(row.document_id)) orphanVectorDocRowIds.push(row.rowid);
  }
  const ftsVideoRows = db.prepare("SELECT rowid, video_id, channel_id FROM transcript_segments_fts")
    .iterate()[Symbol.iterator]() as Iterator<{ rowid: number; video_id: string; channel_id: string }>;
  for (let next = ftsVideoRows.next(); !next.done; next = ftsVideoRows.next()) {
    const row = next.value;
    if (!sourceVideoKeys.has(`${row.channel_id}\0${row.video_id}`)) orphanFtsVideoRowIds.push(row.rowid);
  }
  const ftsDocRows = db.prepare("SELECT rowid, document_id FROM docs_fts")
    .iterate()[Symbol.iterator]() as Iterator<{ rowid: number; document_id: string }>;
  for (let next = ftsDocRows.next(); !next.done; next = ftsDocRows.next()) {
    const row = next.value;
    if (!sourceDocIds.has(row.document_id)) orphanFtsDocRowIds.push(row.rowid);
  }

  const orphanIndexVideoKeys = (db.prepare("SELECT video_id, channel_id FROM transcript_index").all() as { video_id: string; channel_id: string }[])
    .filter(row => !sourceVideoKeys.has(`${row.channel_id}\0${row.video_id}`));

  const deleteRowIds = (sql: string, rowIds: number[]): number => {
    if (rowIds.length === 0) return 0;
    const statement = db.prepare(sql);
    let removed = 0;
    const batchSize = 500;
    for (let offset = 0; offset < rowIds.length; offset += batchSize) {
      removed += db.transaction((ids: number[]) => {
        let changes = 0;
        for (const rowId of ids) changes += statement.run(rowId).changes;
        return changes;
      })(rowIds.slice(offset, offset + batchSize));
    }
    return removed;
  };

  const vectorRows = deleteRowIds("DELETE FROM vec_segments WHERE rowid = ?", orphanVectorVideoRowIds)
    + deleteRowIds("DELETE FROM vec_docs WHERE rowid = ?", orphanVectorDocRowIds);
  const keywordRows = deleteRowIds("DELETE FROM transcript_segments_fts WHERE rowid = ?", orphanFtsVideoRowIds)
    + deleteRowIds("DELETE FROM docs_fts WHERE rowid = ?", orphanFtsDocRowIds);
  const deleteIndex = db.prepare("DELETE FROM transcript_index WHERE video_id = ? AND channel_id = ?");
  const transcriptIndexes = db.transaction(() => {
    let changes = 0;
    for (const key of orphanIndexVideoKeys) changes += deleteIndex.run(key.video_id, key.channel_id).changes;
    return changes;
  })();

  return {
    removed: vectorRows + keywordRows + transcriptIndexes,
    vectorRows,
    keywordRows,
    transcriptIndexes,
  };
}

export function cleanOrphanedDerivedIndexes(): DerivedIndexCleanupResult {
  return cleanOrphanedDerivedIndexesWithDb(getDb());
}

/** Keep the SQLite-heavy scan and delete work off Express's event loop. The
 * worker opens its own WAL connection to the same database; rowid deletes are
 * committed in small batches, so normal app reads and writes remain usable. */
export function cleanOrphanedDerivedIndexesInWorker(): Promise<DerivedIndexCleanupResult> {
  const require = createRequire(import.meta.url);
  const databaseModule = require.resolve("better-sqlite3");
  const rawExtensionPath = sqliteVec.getLoadablePath();
  const extensionPath = rawExtensionPath.includes("/app.asar/")
    ? rawExtensionPath.replace("/app.asar/", "/app.asar.unpacked/")
    : rawExtensionPath;
  // Function#toString returns the transpiled JavaScript body in both tsx and
  // the production bundle. Keeping the worker self-contained avoids relying
  // on a TypeScript loader or a second packaged entry point.
  const workerSource = `
    import { parentPort, workerData } from "node:worker_threads";
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    const Database = require(workerData.databaseModule);
    const __name = (target) => target;
    const clean = ${cleanOrphanedDerivedIndexesWithDb.toString()};
    let database;
    try {
      database = new Database(workerData.databasePath, { fileMustExist: true });
      database.pragma("journal_mode = WAL");
      database.pragma("busy_timeout = 5000");
      database.loadExtension(workerData.extensionPath);
      parentPort.postMessage({ ok: true, result: clean(database) });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (database) database.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        databasePath: getDb().name,
        databaseModule,
        extensionPath,
      },
    });
    let settled = false;
    worker.once("message", (message: { ok: true; result: DerivedIndexCleanupResult } | { ok: false; error: string }) => {
      settled = true;
      if (message.ok) resolve(message.result);
      else reject(new Error(message.error));
    });
    worker.once("error", error => {
      if (!settled) reject(error);
    });
    worker.once("exit", code => {
      if (!settled && code !== 0) reject(new Error(`Derived index cleanup worker exited with code ${code}`));
      else if (!settled) reject(new Error("Derived index cleanup worker exited without a result"));
    });
  });
}

export async function createDatabaseBackup(destinationFolder: string): Promise<{ path: string; bytes: number }> {
  const folder = path.resolve(destinationFolder);
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let output = path.join(folder, `concord-backup-${stamp}.sqlite`);
  if (fs.existsSync(output)) output = path.join(folder, `concord-backup-${stamp}-${Date.now()}.sqlite`);
  await getDb().backup(output);
  return { path: output, bytes: fs.statSync(output).size };
}

export function validateBackupFile(filePath: string): { ok: true; bytes: number; videos: number; notes: number; documents: number } {
  const resolved = path.resolve(filePath);
  if (!existsFile(resolved)) throw new Error("Backup file does not exist");
  const candidate = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    const integrity = candidate.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`);
    const required = candidate.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('app_config', 'video_queue', 'transcript_clips')
    `).get() as { count: number };
    if (required.count !== 3) throw new Error("File is not a Concord database backup");
    return {
      ok: true,
      bytes: fs.statSync(resolved).size,
      videos: (candidate.prepare("SELECT COUNT(*) AS count FROM video_queue").get() as { count: number }).count,
      notes: (candidate.prepare("SELECT COUNT(*) AS count FROM transcript_clips").get() as { count: number }).count,
      documents: (candidate.prepare("SELECT COUNT(*) AS count FROM documents").get() as { count: number }).count,
    };
  } finally {
    candidate.close();
  }
}

export function stageDatabaseRestore(filePath: string): { pendingPath: string; restartRequired: true } {
  validateBackupFile(filePath);
  const target = getDb().name;
  const pending = `${target}.restore-pending`;
  const temp = `${pending}.${process.pid}.${Date.now()}.tmp`;
  fs.copyFileSync(path.resolve(filePath), temp, fs.constants.COPYFILE_EXCL);
  // Replacing an older *pending* restore is safe: it was never active data.
  if (fs.existsSync(pending)) fs.renameSync(pending, `${pending}.superseded-${Date.now()}`);
  fs.renameSync(temp, pending);
  return { pendingPath: pending, restartRequired: true };
}

const waveformInflight = new Map<string, Promise<string | null>>();

export async function ensureWaveform(entry: QueueEntry): Promise<string | null> {
  if (!entry.video_path || !existsFile(entry.video_path)) return null;
  const key = `${entry.channel_id}:${entry.video_id}`;
  const digest = crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);
  const output = path.join(path.dirname(getDb().name), "waveforms", `${digest}.png`);
  if (existsFile(output) && fs.statSync(output).size > 100) return output;
  const active = waveformInflight.get(key);
  if (active) return active;
  const promise = new Promise<string | null>((resolve) => {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temp = `${output}.${process.pid}.${Date.now()}.tmp.png`;
    const proc = trackChildProcess(spawn(ffmpegBin, [
      "-i", entry.video_path!, "-filter_complex",
      "aformat=channel_layouts=mono,showwavespic=s=1200x180:colors=#8b9cff",
      "-frames:v", "1", "-y", temp,
    ], { stdio: "ignore" }), "ffmpeg waveform");
    proc.on("error", () => resolve(null));
    proc.on("close", code => {
      try {
        if (code === 0 && existsFile(temp) && fs.statSync(temp).size > 100) {
          fs.renameSync(temp, output);
          resolve(output);
        } else {
          if (fs.existsSync(temp)) fs.unlinkSync(temp);
          resolve(null);
        }
      } finally {
        waveformInflight.delete(key);
      }
    });
  });
  waveformInflight.set(key, promise);
  return promise;
}
