/**
 * Markdown docs indexer — walks the configured root folder and keeps
 * the `documents` table in sync with the filesystem. v1: just metadata
 * (title, hash, mtime). v2 layers on chunking + embeddings.
 *
 * The doc id is a deterministic hash of the relative path so it
 * survives content edits — note_anchors / star / category state stays
 * attached even after the file body changes. Renames look like a new
 * doc + old doc removed, which is good enough for the typical case
 * (notes follow paths, not file identity).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getConfigValues, getDb } from "./db";

export interface DocumentRow {
  id: string;
  rel_path: string;
  title: string;
  starred: number;
  category: string;
  content_hash: string;
  bytes: number;
  mtime_ms: number;
  created_at: string;
  updated_at: string;
}

export function docIdFromRelPath(relPath: string): string {
  // Short, stable, URL-safe. Avoid characters that need URL encoding
  // so the id can appear in route params without ceremony.
  return "doc:" + crypto.createHash("sha256").update(relPath).digest("base64url").slice(0, 24);
}

/** First H1 in the file, falling back to the filename (without
 *  extension). Used so the Docs list shows something readable when the
 *  user hasn't given the file a title. */
function extractTitle(content: string, relPath: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return path.basename(relPath, path.extname(relPath));
}

/** Walk the docs root and return every .md file (relPath + absPath).
 *  Skips dotfiles and node_modules. Returns an array rather than a
 *  generator so the TS target stays compatible without a downlevel
 *  iteration flag. */
function walkMd(absRoot: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (relPath: string) => {
    const abs = path.join(absRoot, relPath);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const childRel = path.posix.join(relPath, entry.name);
      const childAbs = path.join(absRoot, childRel);
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) out.push({ rel: childRel, abs: childAbs });
    }
  };
  walk("");
  return out;
}

function sha256File(absPath: string): { hash: string; bytes: number } {
  const buf = fs.readFileSync(absPath);
  const hash = crypto.createHash("sha256").update(buf).digest("hex");
  return { hash, bytes: buf.length };
}

export interface IndexResult {
  inserted: number;
  updated: number;
  removed: number;
  unchanged: number;
  total: number;
  ms: number;
}

/** Full sync between disk and the documents table. Cheap for ≤ low
 *  thousands of files (single readdir + sha256 per file). Run on:
 *  startup, docs.rootFolder change, and the explicit Refresh button. */
export function indexDocs(): IndexResult {
  const t0 = Date.now();
  const root = getConfigValues()["docs.rootFolder"] || "";
  if (!root || !fs.existsSync(root)) {
    return { inserted: 0, updated: 0, removed: 0, unchanged: 0, total: 0, ms: 0 };
  }

  const db = getDb();
  const existingRows = db
    .prepare("SELECT id, rel_path, content_hash FROM documents")
    .all() as Pick<DocumentRow, "id" | "rel_path" | "content_hash">[];
  const existingByPath = new Map(existingRows.map((r) => [r.rel_path, r]));

  const seenPaths = new Set<string>();
  let inserted = 0, updated = 0, unchanged = 0;

  const insertStmt = db.prepare(`
    INSERT INTO documents (id, rel_path, title, content_hash, bytes, mtime_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE documents
       SET title = ?, content_hash = ?, bytes = ?, mtime_ms = ?,
           updated_at = datetime('now')
     WHERE id = ?
  `);

  db.transaction(() => {
    for (const { rel, abs } of walkMd(root)) {
      seenPaths.add(rel);
      let stat: fs.Stats;
      let hash: string, bytes: number, title: string;
      try {
        stat = fs.statSync(abs);
        ({ hash, bytes } = sha256File(abs));
        title = extractTitle(fs.readFileSync(abs, "utf-8"), rel);
      } catch (err) {
        console.warn(`[docs-index] Skipping ${rel}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      const id = docIdFromRelPath(rel);
      const existing = existingByPath.get(rel);

      if (!existing) {
        insertStmt.run(id, rel, title, hash, bytes, stat.mtimeMs);
        inserted += 1;
      } else if (existing.content_hash !== hash) {
        updateStmt.run(title, hash, bytes, stat.mtimeMs, existing.id);
        updated += 1;
      } else {
        unchanged += 1;
      }
    }
  })();

  // Remove rows for files that disappeared. Cascades to note_anchors
  // for any doc-anchored notes — that's intended; if the file is
  // gone, the anchor has nothing to point at. (Notes themselves
  // survive in transcript_clips even when all their anchors are gone.)
  let removed = 0;
  const deleteStmt = db.prepare("DELETE FROM documents WHERE id = ?");
  db.transaction(() => {
    for (const row of existingRows) {
      if (!seenPaths.has(row.rel_path)) {
        deleteStmt.run(row.id);
        removed += 1;
      }
    }
  })();

  return {
    inserted, updated, removed, unchanged,
    total: seenPaths.size,
    ms: Date.now() - t0,
  };
}

export function listDocuments(opts?: {
  category?: "personal" | "work";
  starred?: boolean;
}): DocumentRow[] {
  const where: string[] = [];
  const params: any[] = [];
  if (opts?.category) {
    where.push("category = ?");
    params.push(opts.category);
  }
  if (opts?.starred) {
    where.push("starred = 1");
  }
  const sql = `SELECT * FROM documents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rel_path ASC`;
  return getDb().prepare(sql).all(...params) as DocumentRow[];
}

export function getDocument(id: string): DocumentRow | undefined {
  return getDb().prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow | undefined;
}

export function getDocumentByRelPath(relPath: string): DocumentRow | undefined {
  return getDb()
    .prepare("SELECT * FROM documents WHERE rel_path = ?")
    .get(relPath) as DocumentRow | undefined;
}

export function setDocumentStarred(id: string, starred: boolean): void {
  getDb()
    .prepare("UPDATE documents SET starred = ?, updated_at = datetime('now') WHERE id = ?")
    .run(starred ? 1 : 0, id);
}

export function setDocumentCategory(id: string, category: "personal" | "work"): void {
  const c = category === "work" ? "work" : "personal";
  getDb()
    .prepare("UPDATE documents SET category = ?, updated_at = datetime('now') WHERE id = ?")
    .run(c, id);
}
