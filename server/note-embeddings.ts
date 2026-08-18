import { embed } from "./llm";
import { EMBEDDING_DIM, getConfigValues, getDb } from "./db";
import { normalizeVector } from "./db-embeddings";

interface NoteIndexText {
  id: string;
  title: string;
  body: string;
  tags: string;
  anchors: string;
  text: string;
}

export interface EmbedNoteResult {
  noteId: string;
  embedded: number;
  skipped: number;
  ms: number;
  error?: string;
}

function float32ToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** Build the single searchable record for a research note. Keeping the
 * title, authored body, tags, and evidence excerpts together makes notes
 * useful to RAG without confusing their evidence with the user's own words. */
export function getNoteIndexText(noteId: string): NoteIndexText | undefined {
  const row = getDb().prepare(`
    SELECT
      c.id,
      c.title,
      COALESCE(c.note, '') AS body,
      COALESCE((
        SELECT group_concat(tag, ', ') FROM (
          SELECT tag FROM clip_tags WHERE clip_id = c.id ORDER BY tag
        )
      ), '') AS tags,
      COALESCE((
        SELECT group_concat(excerpt, '\n') FROM (
          SELECT excerpt FROM note_anchors
          WHERE clip_id = c.id AND excerpt IS NOT NULL AND trim(excerpt) <> ''
          ORDER BY ordinal
        )
      ), '') AS anchors
    FROM transcript_clips c
    WHERE c.id = ?
  `).get(noteId) as Omit<NoteIndexText, "text"> | undefined;
  if (!row) return undefined;

  const parts = [
    `Note: ${row.title}`,
    row.body ? `Body:\n${row.body}` : "",
    row.tags ? `Tags: ${row.tags}` : "",
    row.anchors ? `Evidence excerpts:\n${row.anchors}` : "",
  ].filter(Boolean);
  // Notes can accumulate many long anchors. The user's title/body have the
  // highest value, so retain the beginning and cap the embedding input.
  return { ...row, text: parts.join("\n\n").slice(0, 12_000) };
}

export async function embedNote(
  noteId: string,
  opts: { model?: string; skipIfPresent?: boolean } = {},
): Promise<EmbedNoteResult> {
  const started = Date.now();
  const note = getNoteIndexText(noteId);
  if (!note) {
    removeNoteEmbedding(noteId);
    return { noteId, embedded: 0, skipped: 0, ms: Date.now() - started, error: "Note not found" };
  }
  const model = opts.model || getConfigValues()["llm.embeddingModel"];
  if (!model) {
    return { noteId, embedded: 0, skipped: 0, ms: Date.now() - started, error: "No embedding model configured" };
  }
  if (opts.skipIfPresent) {
    const existing = getDb().prepare(
      "SELECT 1 FROM vec_notes WHERE note_id = ? AND model = ? LIMIT 1",
    ).get(noteId, model);
    if (existing) return { noteId, embedded: 0, skipped: 1, ms: Date.now() - started };
  }

  // Fetch/validate before replacing the old row. A failed model call leaves
  // the last good note vector intact, matching docs/video embedding safety.
  const [raw] = await embed({
    texts: [note.text],
    model,
    expectedDimensions: EMBEDDING_DIM,
  });
  const vector = normalizeVector(raw);
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM vec_notes WHERE note_id = ? AND model = ?").run(noteId, model);
    db.prepare(`
      INSERT INTO vec_notes (embedding, note_id, model, text, title, tags)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(float32ToBuffer(vector), noteId, model, note.text, note.title, note.tags);
  })();
  return { noteId, embedded: 1, skipped: 0, ms: Date.now() - started };
}

export function removeNoteEmbedding(noteId: string): number {
  return getDb().prepare("DELETE FROM vec_notes WHERE note_id = ?").run(noteId).changes;
}

export function listNoteIds(): string[] {
  return (getDb().prepare("SELECT id FROM transcript_clips ORDER BY created_at, id").all() as { id: string }[])
    .map(row => row.id);
}

export function getNoteEmbeddingStats(): { notes: number; models: { model: string; notes: number }[] } {
  const models = getDb().prepare(`
    SELECT model, COUNT(DISTINCT note_id) AS notes
    FROM vec_notes GROUP BY model ORDER BY model
  `).all() as { model: string; notes: number }[];
  return { notes: listNoteIds().length, models };
}

const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

/** Coalesce rapid title/body/tag/anchor edits into one model call. Keyword
 * retrieval reads the live note tables immediately; the semantic vector
 * follows shortly after without delaying the save response. */
export function scheduleNoteEmbedding(noteId: string, delayMs = 1_500): void {
  const prior = scheduled.get(noteId);
  if (prior) clearTimeout(prior);
  scheduled.set(noteId, setTimeout(() => {
    scheduled.delete(noteId);
    void embedNote(noteId).catch(error => {
      console.warn(`[notes] embedding ${noteId} failed:`, error instanceof Error ? error.message : error);
    });
  }, delayMs));
}

