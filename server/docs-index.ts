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
import { getConfigValues, getDb, setConfigValues } from "./db";
import { embedDocument, chunkMarkdown } from "./docs-embed";

/** Rebuild the docs_fts keyword index for one document from its
 *  current content. Same chunk boundaries the embedder uses, so a
 *  keyword hit deep-links to the same passage a semantic hit would.
 *  Runs during indexing — independent of any embedding model — so
 *  keyword search of docs works even when embeddings aren't set up.
 *  Pass the already-read file content to avoid a second read. */
function reindexDocFts(db: ReturnType<typeof getDb>, documentId: string, content: string): void {
  db.prepare("DELETE FROM docs_fts WHERE document_id = ?").run(documentId);
  const chunks = chunkMarkdown(content);
  if (chunks.length === 0) return;
  const insert = db.prepare(`
    INSERT INTO docs_fts (document_id, chunk_index, heading_path, start_char, end_char, text)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const c of chunks) {
    insert.run(documentId, c.index, c.headingPath || null, c.startChar, c.endChar, c.text);
  }
}

export interface DocumentRow {
  id: string;
  rel_path: string;
  title: string;
  starred: number;
  category: string;
  content_hash: string;
  bytes: number;
  mtime_ms: number;
  root_id: string | null;
  /** Raw author string from the doc's YAML frontmatter (`author:`).
   *  Null when the doc declares none. */
  author: string | null;
  /** Resolved global speaker id when `author` matches a known speaker
   *  (case-insensitive); null otherwise. Links docs + transcripts by
   *  the same person. */
  speaker_id: string | null;
  created_at: string;
  updated_at: string;
}

/** A single configured docs root. Roots are stored as a JSON array in
 *  app_config under "docs.rootFolders". Each has a stable id (random
 *  base64url) so the path can change without breaking note_anchors /
 *  vec_docs (which reference documents.id, which references root_id).
 *  Label is the display name in the Docs sidebar; defaults to the
 *  basename of the path. */
export interface DocsRoot {
  id: string;
  path: string;
  label: string;
}

export function docIdFromRelPath(relPath: string, rootId = ""): string {
  // Short, stable, URL-safe. Avoid characters that need URL encoding
  // so the id can appear in route params without ceremony. The
  // empty-rootId variant matches the pre-multi-root scheme so
  // existing docs keep their ids (and so notes / embeddings / map
  // links don't orphan after the migration).
  const key = rootId ? `${rootId}:${relPath}` : relPath;
  return "doc:" + crypto.createHash("sha256").update(key).digest("base64url").slice(0, 24);
}

// ---- Roots config -------------------------------------------------

const LEGACY_ROOT_ID = ""; // empty = backwards-compatible doc id format

/** Read the configured roots, auto-migrating from the legacy
 *  single-folder setting on first call. Returns at most one entry
 *  when the user hasn't added a second root yet. */
export function listRoots(): DocsRoot[] {
  const cfg = getConfigValues();
  const raw = cfg["docs.rootFolders"];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((r): r is DocsRoot => !!r && typeof r.id === "string" && typeof r.path === "string")
          .map((r) => ({ id: r.id, path: r.path, label: r.label || path.basename(r.path) || r.path }));
      }
    } catch { /* fall through to legacy migration */ }
  }
  // Legacy migration: wrap the single-folder setting into the array
  // form using the empty rootId so existing doc ids stay valid.
  const legacy = cfg["docs.rootFolder"];
  if (legacy && legacy.trim()) {
    const root: DocsRoot = {
      id: LEGACY_ROOT_ID,
      path: legacy.trim(),
      label: path.basename(legacy.trim()) || legacy.trim(),
    };
    setConfigValues({ "docs.rootFolders": JSON.stringify([root]) });
    return [root];
  }
  return [];
}

export function setRoots(roots: DocsRoot[]): void {
  setConfigValues({ "docs.rootFolders": JSON.stringify(roots) });
}

export function addRoot(input: { path: string; label?: string }): DocsRoot {
  const trimmed = input.path.trim();
  if (!trimmed) throw new Error("path is required");
  if (!fs.existsSync(trimmed)) throw new Error(`Folder does not exist: ${trimmed}`);
  const roots = listRoots();
  // Deduplicate by normalized absolute path — a second root pointing
  // at the same folder is always a mistake.
  const norm = path.resolve(trimmed);
  if (roots.some((r) => path.resolve(r.path) === norm)) {
    throw new Error("Folder already configured as a root");
  }
  // First root gets the legacy empty id so existing data round-trips
  // cleanly when a user upgrades. Subsequent roots get a random id.
  const id = roots.length === 0 ? LEGACY_ROOT_ID : crypto.randomBytes(6).toString("base64url");
  const root: DocsRoot = {
    id,
    path: trimmed,
    label: input.label?.trim() || path.basename(trimmed) || trimmed,
  };
  setRoots([...roots, root]);
  return root;
}

export function removeRoot(id: string): boolean {
  const roots = listRoots();
  const next = roots.filter((r) => r.id !== id);
  if (next.length === roots.length) return false;
  setRoots(next);
  // Drop documents that belonged to this root; CASCADE wipes their
  // anchors. vec_docs rows hang around as orphans — cheaper to leave
  // than to query them out; the next embed-all backfill is the
  // natural cleanup point if it matters. (Future polish: explicit
  // sweep here.)
  getDb()
    .prepare("DELETE FROM documents WHERE COALESCE(root_id, '') = ?")
    .run(id);
  return true;
}

export function renameRoot(id: string, label: string): DocsRoot | null {
  const roots = listRoots();
  const idx = roots.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  roots[idx] = { ...roots[idx], label: label.trim() || roots[idx].label };
  setRoots(roots);
  return roots[idx];
}

/** First H1 in the file, falling back to the filename (without
 *  extension). Used so the Docs list shows something readable when the
 *  user hasn't given the file a title. */
/** Split a leading YAML frontmatter block (delimited by `---` lines)
 *  from the markdown body. Returns the parsed key→value map (flat,
 *  string values only — enough for `author`, `title`, etc.) plus the
 *  body with the block removed. No YAML dependency: we only need
 *  simple `key: value` lines, which keeps the supply-chain surface
 *  small. A doc with no frontmatter returns {} + the original body. */
export function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  // Must start at the very top (allow a leading BOM / blank lines).
  const m = content.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: content };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // Strip surrounding quotes and a trailing inline comment is left
    // alone (rare in author lines); unwrap a single-item flow list
    // like [Brandon Biggs] → Brandon Biggs (first element).
    if (/^\[.*\]$/.test(value)) {
      value = value.slice(1, -1).split(",")[0].trim();
    }
    value = value.replace(/^["']|["']$/g, "").trim();
    if (value) data[kv[1].toLowerCase()] = value;
  }
  return { data, body: content.slice(m[0].length) };
}

function extractTitle(content: string, relPath: string): string {
  // Look for the title in frontmatter first, then the first H1 in the
  // body, then fall back to the filename.
  const { data, body } = parseFrontmatter(content);
  if (data.title) return data.title;
  const m = body.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return path.basename(relPath, path.extname(relPath));
}

/** Resolve an author name to a global speaker id (case-insensitive
 *  exact match on speakers.name). Returns null when no speaker matches
 *  — the raw author text is still stored, so attribution isn't lost,
 *  it just isn't linked to a person entity yet. */
function resolveSpeakerIdByName(author: string | null): string | null {
  if (!author) return null;
  const row = getDb()
    .prepare("SELECT id FROM speakers WHERE lower(name) = lower(?) AND is_noise = 0 LIMIT 1")
    .get(author.trim()) as { id: string } | undefined;
  return row?.id ?? null;
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
export interface IndexOptions {
  /** Re-embed changed/new docs after the sync. Default true; set false
   *  for tests or environments without an LLM configured. */
  embed?: boolean;
}

export function indexDocs(options: IndexOptions = {}): IndexResult {
  const t0 = Date.now();
  const roots = listRoots().filter((r) => fs.existsSync(r.path));
  if (roots.length === 0) {
    return { inserted: 0, updated: 0, removed: 0, unchanged: 0, total: 0, ms: 0 };
  }

  const db = getDb();
  // Load existing docs for every configured root — keyed by
  // (rootId, relPath). COALESCE handles old rows that pre-date the
  // root_id column (they get treated as belonging to the legacy
  // empty-id root, same as before).
  const existingRows = db
    .prepare("SELECT id, rel_path, content_hash, COALESCE(root_id, '') AS root_id FROM documents")
    .all() as Pick<DocumentRow, "id" | "rel_path" | "content_hash" | "root_id">[];
  const keyFor = (rootId: string, rel: string) => `${rootId} ${rel}`;
  const existingByKey = new Map(existingRows.map((r) => [keyFor(r.root_id ?? "", r.rel_path), r]));

  const seenKeys = new Set<string>();
  const toEmbed: string[] = [];
  let inserted = 0, updated = 0, unchanged = 0;

  const insertStmt = db.prepare(`
    INSERT INTO documents (id, rel_path, title, content_hash, bytes, mtime_ms, root_id, author, speaker_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE documents
       SET title = ?, content_hash = ?, bytes = ?, mtime_ms = ?,
           author = ?, speaker_id = ?, updated_at = datetime('now')
     WHERE id = ?
  `);

  db.transaction(() => {
    for (const root of roots) {
      for (const { rel, abs } of walkMd(root.path)) {
        const key = keyFor(root.id, rel);
        seenKeys.add(key);
        let stat: fs.Stats;
        let hash: string, bytes: number, title: string;
        let content = "";
        let author: string | null = null;
        let speakerId: string | null = null;
        try {
          stat = fs.statSync(abs);
          ({ hash, bytes } = sha256File(abs));
          content = fs.readFileSync(abs, "utf-8");
          title = extractTitle(content, rel);
          author = parseFrontmatter(content).data.author ?? null;
          speakerId = resolveSpeakerIdByName(author);
        } catch (err) {
          console.warn(`[docs-index] Skipping ${root.label}/${rel}: ${err instanceof Error ? err.message : err}`);
          continue;
        }

        const id = docIdFromRelPath(rel, root.id);
        const existing = existingByKey.get(key);

        if (!existing) {
          insertStmt.run(id, rel, title, hash, bytes, stat.mtimeMs, root.id, author, speakerId);
          reindexDocFts(db, id, content);
          inserted += 1;
          toEmbed.push(id);
        } else if (existing.content_hash !== hash) {
          updateStmt.run(title, hash, bytes, stat.mtimeMs, author, speakerId, existing.id);
          reindexDocFts(db, existing.id, content);
          updated += 1;
          toEmbed.push(existing.id);
        } else {
          unchanged += 1;
        }
      }
    }
  })();

  // Remove rows for files that disappeared from any of their roots.
  // Cascades to note_anchors for any doc-anchored notes — intended.
  // Notes themselves survive in transcript_clips even when all their
  // anchors are gone.
  let removed = 0;
  const deleteStmt = db.prepare("DELETE FROM documents WHERE id = ?");
  const deleteFtsStmt = db.prepare("DELETE FROM docs_fts WHERE document_id = ?");
  db.transaction(() => {
    for (const row of existingRows) {
      const key = keyFor(row.root_id ?? "", row.rel_path);
      if (!seenKeys.has(key)) {
        deleteStmt.run(row.id);
        deleteFtsStmt.run(row.id);
        removed += 1;
      }
    }
  })();

  // One-time backfill: docs indexed before docs_fts existed are
  // "unchanged" each run, so the main loop never builds their keyword
  // rows. Catch any document with zero FTS rows and index it now.
  // Self-limiting — once every doc has rows this query returns empty.
  const rootPathById = new Map(roots.map((r) => [r.id, r.path]));
  const missingFts = db.prepare(`
    SELECT id, rel_path, COALESCE(root_id, '') AS root_id
    FROM documents
    WHERE id NOT IN (SELECT DISTINCT document_id FROM docs_fts)
  `).all() as { id: string; rel_path: string; root_id: string }[];
  if (missingFts.length > 0) {
    db.transaction(() => {
      for (const d of missingFts) {
        const base = rootPathById.get(d.root_id) ?? roots[0]?.path;
        if (!base) continue;
        try {
          const c = fs.readFileSync(path.join(base, d.rel_path), "utf-8");
          reindexDocFts(db, d.id, c);
        } catch { /* file gone — the delete pass above already handles it */ }
      }
    })();
    console.log(`[docs-index] Backfilled keyword index for ${missingFts.length} doc(s)`);
  }

  // Re-resolve author → speaker links for ALL docs in one pass. This
  // is what makes "I labeled a Brandon Biggs speaker last week, now my
  // older Brandon docs should link to him" work on a plain Refresh
  // without touching the files. Cheap — a single correlated UPDATE.
  // is_noise speakers are excluded so a doc never links to a noise
  // cluster that happens to share a name.
  db.prepare(`
    UPDATE documents
       SET speaker_id = (
         SELECT s.id FROM speakers s
         WHERE lower(s.name) = lower(documents.author) AND s.is_noise = 0
         LIMIT 1
       )
     WHERE author IS NOT NULL AND author <> ''
  `).run();

  // Re-embed changed/new docs in the background — don't block the
  // sync response on the LLM round-trip. Each call is best-effort;
  // an unconfigured embedding model just logs a warning and skips.
  if (options.embed !== false && toEmbed.length > 0) {
    void (async () => {
      for (const id of toEmbed) {
        try {
          const r = await embedDocument(id);
          if (r.error) {
            console.warn(`[docs-embed] ${id} → ${r.error}`);
          } else if (r.embedded > 0) {
            console.log(`[docs-embed] ${id} → ${r.embedded} chunks (${r.ms}ms)`);
          }
        } catch (err) {
          console.warn(`[docs-embed] ${id} failed:`, err instanceof Error ? err.message : err);
        }
      }
    })();
  }

  return {
    inserted, updated, removed, unchanged,
    total: seenKeys.size,
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

export function getDocumentByRelPath(relPath: string, rootId?: string): DocumentRow | undefined {
  if (rootId !== undefined) {
    return getDb()
      .prepare("SELECT * FROM documents WHERE rel_path = ? AND COALESCE(root_id, '') = ?")
      .get(relPath, rootId) as DocumentRow | undefined;
  }
  // Back-compat: return the first match across roots. Once a user
  // adds a second root the same rel_path could exist in both —
  // callers that care should pass rootId explicitly.
  return getDb()
    .prepare("SELECT * FROM documents WHERE rel_path = ? LIMIT 1")
    .get(relPath) as DocumentRow | undefined;
}

/** Resolve a doc id from (rootId, relPath) — the routes use this to
 *  build deep-link URLs. */
export function findRootById(rootId: string): DocsRoot | undefined {
  return listRoots().find((r) => r.id === rootId);
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
