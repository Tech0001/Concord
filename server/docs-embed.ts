/**
 * Markdown chunking + embedding for the docs index.
 *
 * Strategy:
 *   1. Split the source on H1/H2/H3 boundaries. Each section becomes
 *      a candidate chunk; carries the heading path ("H1 > H2 > H3")
 *      so retrieval results have semantic context without re-reading
 *      the whole doc.
 *   2. If a section's text exceeds the soft target size, further
 *      split by paragraph (blank-line boundaries). Each split keeps
 *      the same heading path.
 *   3. Embed each chunk via the configured embedding model, store
 *      the unit-normalized vector in vec_docs alongside the chunk's
 *      character offsets so retrieval can deep-link back to the
 *      exact passage in the source.
 *
 * The character offsets are computed in the ORIGINAL markdown source
 * so notes anchored to passages can be merged with chunk retrievals
 * later — same address space.
 */

import fs from "fs";
import path from "path";
import { embed } from "./llm";
import { getDb, getConfigValues } from "./db";
import { normalizeVector } from "./db-embeddings";
import { listRoots } from "./docs-index";

const SOFT_CHUNK_CHARS = 1800;   // ~450 tokens for typical English prose
const HARD_CHUNK_CHARS = 4000;   // bail-out cap before brute split

export interface DocChunk {
  index: number;
  text: string;
  headingPath: string;
  startChar: number;
  endChar: number;
}

/** Files saved by the Excalidraw VS Code plugin embed a giant base64
 *  scene blob between `==⚠ Switch to EXCALIDRAW VIEW` and the next
 *  `%%`. The blob is binary noise to an embedder — strip it before
 *  chunking so we don't waste tokens (and cosine space) on it. The
 *  viewer already does the same for rendering. */
function stripExcalidrawScene(source: string): string {
  const sceneStart = source.indexOf("==⚠ Switch to EXCALIDRAW VIEW");
  if (sceneStart === -1) return source;
  return source.slice(0, sceneStart).trimEnd() + "\n";
}

/** Split source markdown into ordered, addressable chunks. Headings
 *  are kept WITH the body they head (so a chunk's first line is its
 *  heading when applicable). */
export function chunkMarkdown(rawSource: string): DocChunk[] {
  const source = stripExcalidrawScene(rawSource);
  const headingPath: string[] = [];
  const lines = source.split("\n");
  // Pass 1: section boundaries (any H1/H2/H3 line starts a new section).
  type Section = { startChar: number; endChar: number; headingPath: string };
  const sections: Section[] = [];
  let charCursor = 0;
  let currentStart = 0;
  let currentPath = "";

  const flushSection = (endChar: number) => {
    if (endChar > currentStart) {
      sections.push({ startChar: currentStart, endChar, headingPath: currentPath });
    }
  };

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for the \n that split() stripped
    const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (m) {
      // Close previous section just before this heading.
      flushSection(charCursor);
      currentStart = charCursor;
      const level = m[1].length;
      const text = m[2].trim();
      headingPath.length = level - 1; // truncate to parent level
      headingPath[level - 1] = text;
      currentPath = headingPath.filter(Boolean).join(" › ");
    }
    charCursor += lineLen;
  }
  flushSection(source.length);

  if (sections.length === 0) {
    // No headings — treat the whole doc as one section.
    sections.push({ startChar: 0, endChar: source.length, headingPath: "" });
  }

  // Pass 2: split oversized sections by paragraph; tiny sections pass
  // through as single chunks.
  const chunks: DocChunk[] = [];
  let chunkIndex = 0;
  for (const sec of sections) {
    const body = source.slice(sec.startChar, sec.endChar).trim();
    if (!body) continue;

    if (body.length <= SOFT_CHUNK_CHARS) {
      chunks.push({
        index: chunkIndex++,
        text: body,
        headingPath: sec.headingPath,
        startChar: sec.startChar,
        endChar: sec.endChar,
      });
      continue;
    }

    // Split this section into paragraph blocks. Keep accumulating
    // paragraphs into a chunk until the next would push past the
    // soft target — flush then start fresh.
    const blocks = splitParagraphs(source, sec.startChar, sec.endChar);
    let bufStart = -1;
    let bufEnd = -1;
    let bufText = "";

    const flushBuf = () => {
      if (bufStart === -1 || !bufText.trim()) return;
      chunks.push({
        index: chunkIndex++,
        text: bufText.trim(),
        headingPath: sec.headingPath,
        startChar: bufStart,
        endChar: bufEnd,
      });
      bufStart = -1;
      bufEnd = -1;
      bufText = "";
    };

    for (const blk of blocks) {
      const proposedLen = bufText.length + blk.text.length + 2;
      if (bufStart !== -1 && proposedLen > SOFT_CHUNK_CHARS) {
        flushBuf();
      }
      if (bufStart === -1) {
        bufStart = blk.startChar;
      }
      bufEnd = blk.endChar;
      bufText += (bufText ? "\n\n" : "") + blk.text;
      // Hard split: a single block longer than HARD_CHUNK_CHARS gets
      // brute-cut so we don't blow past the embedder's context.
      if (bufText.length > HARD_CHUNK_CHARS) flushBuf();
    }
    flushBuf();
  }

  return chunks;
}

function splitParagraphs(source: string, start: number, end: number): { text: string; startChar: number; endChar: number }[] {
  const out: { text: string; startChar: number; endChar: number }[] = [];
  let i = start;
  let blkStart = start;
  let inBlank = true;
  while (i < end) {
    const isBlankLine = (() => {
      const lineEnd = source.indexOf("\n", i);
      const stop = lineEnd === -1 ? end : Math.min(lineEnd, end);
      return source.slice(i, stop).trim().length === 0;
    })();
    if (isBlankLine) {
      if (!inBlank) {
        // close previous block
        out.push({ text: source.slice(blkStart, i).trim(), startChar: blkStart, endChar: i });
      }
      inBlank = true;
    } else {
      if (inBlank) blkStart = i;
      inBlank = false;
    }
    const nextNl = source.indexOf("\n", i);
    i = nextNl === -1 ? end : nextNl + 1;
  }
  if (!inBlank) out.push({ text: source.slice(blkStart, end).trim(), startChar: blkStart, endChar: end });
  return out.filter(b => b.text.length > 0);
}

interface EmbedDocOptions {
  /** Override the embedding model — usually defaults from llm config. */
  model?: string;
  /** Skip when the doc's chunks for the current model are already
   *  present (computed by counting existing rows). */
  skipIfPresent?: boolean;
}

export interface EmbedDocResult {
  documentId: string;
  chunks: number;
  embedded: number;
  skipped: number;
  ms: number;
  error?: string;
}

/** Re-embed a single document. Deletes existing chunks for the same
 *  (document_id, model) pair first so re-embedding after an edit is a
 *  clean replace rather than an accumulating set. */
export async function embedDocument(documentId: string, opts: EmbedDocOptions = {}): Promise<EmbedDocResult> {
  const t0 = Date.now();
  const db = getDb();
  // Pull root_id so we can resolve the file under the correct root —
  // a doc id alone isn't enough now that multiple roots can share a
  // rel_path. COALESCE handles legacy rows from before the column
  // existed; those map to the empty-id root.
  const doc = db
    .prepare("SELECT id, rel_path, COALESCE(root_id, '') AS root_id FROM documents WHERE id = ?")
    .get(documentId) as { id: string; rel_path: string; root_id: string } | undefined;
  if (!doc) return { documentId, chunks: 0, embedded: 0, skipped: 0, ms: 0, error: "Document not found" };

  const roots = listRoots();
  const docRoot = roots.find((r) => r.id === doc.root_id) ?? roots[0];
  if (!docRoot) return { documentId, chunks: 0, embedded: 0, skipped: 0, ms: 0, error: "Docs root not configured" };

  const absPath = path.join(docRoot.path, doc.rel_path);
  if (!fs.existsSync(absPath)) {
    return { documentId, chunks: 0, embedded: 0, skipped: 0, ms: 0, error: "File missing on disk" };
  }

  const source = fs.readFileSync(absPath, "utf-8");
  const chunks = chunkMarkdown(source);
  if (chunks.length === 0) {
    return { documentId, chunks: 0, embedded: 0, skipped: 0, ms: Date.now() - t0 };
  }

  let model = opts.model;
  if (!model) {
    const cfg = getConfigValues();
    model = cfg["llm.embeddingModel"];
  }
  if (!model) {
    return { documentId, chunks: chunks.length, embedded: 0, skipped: 0, ms: Date.now() - t0, error: "No embedding model configured" };
  }

  if (opts.skipIfPresent) {
    const existing = db.prepare(
      "SELECT COUNT(*) AS c FROM vec_docs WHERE document_id = ? AND model = ?"
    ).get(documentId, model) as { c: number };
    if (existing.c === chunks.length) {
      return { documentId, chunks: chunks.length, embedded: 0, skipped: chunks.length, ms: Date.now() - t0 };
    }
  }

  // Replace existing chunks for this (doc, model). Vec0 doesn't
  // support partial-row updates; full delete+insert keeps things
  // simple and correct.
  db.prepare("DELETE FROM vec_docs WHERE document_id = ? AND model = ?").run(documentId, model);

  // Embed in modest batches so a huge doc doesn't blow up a single
  // request. Most embedders cap at ~32-64 inputs per call.
  const BATCH = 16;
  const insert = db.prepare(`
    INSERT INTO vec_docs (embedding, document_id, chunk_index, model, text, heading_path, start_char, end_char)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let embedded = 0;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const slice = chunks.slice(i, i + BATCH);
    // Doc passages get embedded raw — same convention as transcript
    // segments in embed-segments.ts (no document-side instruction
    // prefix; the query side gets the prefix via formatEmbeddingQuery).
    const inputs = slice.map(c => c.text);
    const vectors = await embed({ texts: inputs, model });
    db.transaction(() => {
      for (let j = 0; j < slice.length; j++) {
        const v = normalizeVector(vectors[j]);
        const c = slice[j];
        insert.run(
          float32ToBuffer(v),
          documentId,
          // BigInt forces INTEGER binding — better-sqlite3 binds plain
          // JS numbers as REAL/FLOAT by default, which vec0 strictly
          // rejects for INTEGER aux columns ("type mismatch" error).
          BigInt(c.index),
          model,
          c.text,
          c.headingPath || null,
          BigInt(c.startChar),
          BigInt(c.endChar),
        );
        embedded += 1;
      }
    })();
  }

  return { documentId, chunks: chunks.length, embedded, skipped: 0, ms: Date.now() - t0 };
}

function float32ToBuffer(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
