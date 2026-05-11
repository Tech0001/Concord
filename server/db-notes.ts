import { getDb } from "./db";

// ---------------------------------------------------------------
// Notes (transcript_clips) + anchors + tags + links + graph
//
// A "note" is the user's first-class research artifact. Schema-wise
// it's still called transcript_clips for historical reasons; the UI
// and most exported names use "note" / "notes." Each note has:
//   - title + body (the user's writing)
//   - 0..N anchors in note_anchors (video moments as evidence)
//   - N tags in clip_tags
//   - N links to other notes in clip_links (manual, typed)
//
// getClipGraph derives a (node, edge) view for the Map page: nodes
// are clips, edges are manual links + shared tags + same-video
// adjacency (anchor-aware).
// ---------------------------------------------------------------

export interface NoteAnchor {
  ordinal: number;
  video_id: string;
  channel_id: string;
  /** Channel display name + video title resolved from video_queue (joined
   *  on read). Null when the referenced video has been deleted from the
   *  archive — the anchor still points at a stable (video_id, channel_id)
   *  pair, the UI just can't pretty-print it. */
  channel_name: string | null;
  video_title: string | null;
  upload_date: string | null;
  /** NULL means "the whole video, no specific moment" (whole-video anchor). */
  start_seconds: number | null;
  end_seconds: number | null;
  /** Snapshot of transcript text at the time the anchor was saved.
   *  Stable even if the underlying transcript is regenerated. */
  excerpt: string | null;
  /** Playback metadata re-resolved on read so the UI can hand the anchor
   *  straight to VideoDrawer without an extra round-trip. Not stored on
   *  the anchor row — paths can change. */
  video_path: string | null;
  md_path: string | null;
  status: string | null;
  is_live: number | null;
  duration: number | null;
  word_count: number | null;
}

export interface TranscriptClip {
  id: string;
  /** Legacy single-anchor mirror (video_id, channel_id, start_seconds,
   *  end_seconds, quote, channel_name, upload_date) — populated from the
   *  first anchor for back-compat. New code should prefer `anchors`. */
  video_id: string;
  channel_id: string;
  title: string;
  channel_name: string | null;
  upload_date: string | null;
  start_seconds: number;
  end_seconds: number;
  quote: string;
  note: string | null;
  created_at: string;
  updated_at: string;
  video_path: string | null;
  md_path: string | null;
  word_count: number;
  is_live: number;
  duration: number | null;
  status: string;
  tags: string[];
  /** Multi-anchor evidence list. Always at least 1 in v1 (standalone
   *  zero-anchor notes deferred to a future schema migration). Sorted by
   *  ordinal ascending. */
  anchors: NoteAnchor[];
}

export interface TagCount {
  tag: string;
  count: number;
}



/**
 * Tag normalization. Lowercase + trim, collapse internal whitespace, allow
 * dots for hierarchy (e.g. "religion.end-times.rapture"). Returns "" for
 * tags that aren't worth storing.
 */
function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function dedupe(strings: string[]): string[] {
  return Array.from(new Set(strings));
}

export function setClipTags(clipId: string, rawTags: string[]): string[] {
  const tags = dedupe(rawTags.map(normalizeTag).filter(t => t.length > 0));
  const db = getDb();
  const apply = db.transaction((nextTags: string[]) => {
    db.prepare("DELETE FROM clip_tags WHERE clip_id = ?").run(clipId);
    if (!nextTags.length) return;
    const insert = db.prepare("INSERT INTO clip_tags (clip_id, tag) VALUES (?, ?)");
    for (const tag of nextTags) insert.run(clipId, tag);
  });
  apply(tags);
  return tags;
}

export function getClipTags(clipId: string): string[] {
  return (
    getDb()
      .prepare("SELECT tag FROM clip_tags WHERE clip_id = ? ORDER BY tag")
      .all(clipId) as { tag: string }[]
  ).map(row => row.tag);
}

function attachTagsToClips<T extends { id: string }>(clips: T[]): (T & { tags: string[] })[] {
  if (!clips.length) return [] as (T & { tags: string[] })[];
  const ids = clips.map(c => c.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(`SELECT clip_id, tag FROM clip_tags WHERE clip_id IN (${placeholders}) ORDER BY tag`)
    .all(...ids) as { clip_id: string; tag: string }[];

  const byClip = new Map<string, string[]>();
  for (const row of rows) {
    const list = byClip.get(row.clip_id);
    if (list) list.push(row.tag);
    else byClip.set(row.clip_id, [row.tag]);
  }
  return clips.map(clip => ({ ...clip, tags: byClip.get(clip.id) ?? [] }));
}

/** Bulk-load anchors for many clips and attach as `anchors[]`. Joined to
 *  video_queue + channels so each anchor carries display-friendly title /
 *  channel name / upload date for the UI. */
function attachAnchorsToClips<T extends { id: string }>(clips: T[]): (T & { anchors: NoteAnchor[] })[] {
  if (!clips.length) return [] as (T & { anchors: NoteAnchor[] })[];
  const ids = clips.map(c => c.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT a.clip_id, a.ordinal, a.video_id, a.channel_id,
           a.start_seconds, a.end_seconds, a.excerpt,
           q.title AS video_title, q.upload_date,
           q.video_path, q.md_path, q.status, q.is_live, q.duration, q.word_count,
           c.name AS channel_name
    FROM note_anchors a
    LEFT JOIN video_queue q ON q.video_id = a.video_id AND q.channel_id = a.channel_id
    LEFT JOIN channels c    ON c.id       = a.channel_id
    WHERE a.clip_id IN (${placeholders})
    ORDER BY a.clip_id, a.ordinal ASC
  `).all(...ids) as (NoteAnchor & { clip_id: string })[];

  const byClip = new Map<string, NoteAnchor[]>();
  for (const r of rows) {
    const { clip_id, ...anchor } = r;
    const list = byClip.get(clip_id);
    if (list) list.push(anchor);
    else byClip.set(clip_id, [anchor]);
  }
  return clips.map(clip => ({ ...clip, anchors: byClip.get(clip.id) ?? [] }));
}

/** Tags + anchors in one pass — what every clip read path wants. */
function hydrateClips<T extends { id: string }>(clips: T[]): (T & { tags: string[]; anchors: NoteAnchor[] })[] {
  return attachAnchorsToClips(attachTagsToClips(clips));
}

export function listAllClipTags(): TagCount[] {
  return getDb()
    .prepare(`
      SELECT tag, COUNT(*) AS count
      FROM clip_tags
      GROUP BY tag
      ORDER BY count DESC, tag ASC
    `)
    .all() as TagCount[];
}

/**
 * Rename or merge a tag. If `includeDescendants` is true, "religion" → "faith"
 * also moves "religion.foo" → "faith.foo". Returns counts so the UI can
 * report "renamed N, merged into existing M".
 */
export function renameClipTag(
  from: string,
  to: string,
  includeDescendants = false,
): { renamed: number; merged: number } {
  const fromN = normalizeTag(from);
  const toN = normalizeTag(to);
  if (!fromN || !toN || fromN === toN) return { renamed: 0, merged: 0 };

  const db = getDb();
  return db.transaction(() => {
    const sourceRows = (
      includeDescendants
        ? db
            .prepare("SELECT clip_id, tag FROM clip_tags WHERE tag = ? OR tag LIKE ? || '.%'")
            .all(fromN, fromN)
        : db.prepare("SELECT clip_id, tag FROM clip_tags WHERE tag = ?").all(fromN)
    ) as { clip_id: string; tag: string }[];

    const insertOrIgnore = db.prepare("INSERT OR IGNORE INTO clip_tags (clip_id, tag) VALUES (?, ?)");
    const deleteRow = db.prepare("DELETE FROM clip_tags WHERE clip_id = ? AND tag = ?");

    let renamed = 0;
    let merged = 0;
    for (const row of sourceRows) {
      const nextTag =
        includeDescendants && row.tag !== fromN
          ? toN + row.tag.slice(fromN.length)
          : toN;
      const result = insertOrIgnore.run(row.clip_id, nextTag);
      if (result.changes > 0) renamed += 1;
      else merged += 1;
      deleteRow.run(row.clip_id, row.tag);
    }
    return { renamed, merged };
  })();
}

/** Remove a tag globally. Optionally also removes hierarchical descendants. */
export function deleteClipTag(tag: string, includeDescendants = false): number {
  const tagN = normalizeTag(tag);
  if (!tagN) return 0;
  if (includeDescendants) {
    return getDb()
      .prepare("DELETE FROM clip_tags WHERE tag = ? OR tag LIKE ? || '.%'")
      .run(tagN, tagN).changes;
  }
  return getDb().prepare("DELETE FROM clip_tags WHERE tag = ?").run(tagN).changes;
}

export interface CreateNoteAnchorInput {
  videoId: string;
  channelId: string;
  startSeconds?: number | null;
  endSeconds?: number | null;
  excerpt?: string | null;
}

export function createTranscriptClip(clip: {
  id: string;
  /** Single-anchor convenience fields — used when `anchors` is omitted. */
  videoId?: string;
  channelId?: string;
  channelName?: string | null;
  uploadDate?: string | null;
  startSeconds?: number;
  endSeconds?: number;
  quote?: string;
  /** Multi-anchor input. If provided, takes precedence; the legacy
   *  single-anchor columns on transcript_clips are mirrored from
   *  anchors[0]. Must contain at least 1 anchor for v1. */
  anchors?: CreateNoteAnchorInput[];
  title: string;
  note?: string | null;
  tags?: string[];
}): TranscriptClip {
  // Normalize input: build a unified anchors[] list.
  // anchors[] can be empty — standalone "just a thought" notes are allowed.
  const anchors: CreateNoteAnchorInput[] = clip.anchors !== undefined
    ? clip.anchors
    : (clip.videoId && clip.channelId
        ? [{
            videoId: clip.videoId,
            channelId: clip.channelId,
            startSeconds: clip.startSeconds ?? 0,
            endSeconds: clip.endSeconds ?? 0,
            excerpt: clip.quote ?? "",
          }]
        : []);
  const primary = anchors[0];

  const db = getDb();
  db.transaction(() => {
    // Legacy single-anchor columns mirror the FIRST anchor for back-compat
    // with code paths that still read them directly. When there are no
    // anchors (standalone note) these columns are simply left NULL — the
    // table was relaxed in the migration to allow that.
    db.prepare(`
      INSERT INTO transcript_clips (
        id, video_id, channel_id, title, channel_name, upload_date,
        start_seconds, end_seconds, quote, note, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      clip.id,
      primary?.videoId ?? null,
      primary?.channelId ?? null,
      clip.title,
      clip.channelName ?? null,
      clip.uploadDate ?? null,
      primary?.startSeconds ?? null,
      primary?.endSeconds ?? null,
      primary?.excerpt ?? null,
      clip.note?.trim() || null,
    );
    if (anchors.length > 0) {
      const insertAnchor = db.prepare(`
        INSERT INTO note_anchors (clip_id, ordinal, video_id, channel_id, start_seconds, end_seconds, excerpt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      anchors.forEach((a, idx) => {
        insertAnchor.run(
          clip.id,
          idx + 1,
          a.videoId,
          a.channelId,
          a.startSeconds ?? null,
          a.endSeconds ?? null,
          a.excerpt ?? null,
        );
      });
    }
    if (clip.tags?.length) setClipTags(clip.id, clip.tags);
  })();

  const created = getTranscriptClip(clip.id);
  if (!created) throw new Error("Note was not created");
  return created;
}

/** Edit a note's title and/or body text. Anchors and tags are managed
 *  separately via their own endpoints. Returns the updated note. */
export function updateTranscriptClip(
  id: string,
  fields: { title?: string; note?: string | null },
): TranscriptClip | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (fields.title !== undefined) {
    if (!fields.title.trim()) throw new Error("Title cannot be empty");
    sets.push("title = ?");
    params.push(fields.title.trim());
  }
  if (fields.note !== undefined) {
    sets.push("note = ?");
    params.push(fields.note?.trim() || null);
  }
  if (sets.length === 0) return getTranscriptClip(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE transcript_clips SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getTranscriptClip(id);
}

/** Append an anchor to an existing note. Returns the new anchor's ordinal. */
export function addNoteAnchor(noteId: string, input: CreateNoteAnchorInput): number {
  const db = getDb();
  const exists = db.prepare("SELECT 1 FROM transcript_clips WHERE id = ?").get(noteId);
  if (!exists) throw new Error(`Note ${noteId} not found`);
  const maxRow = db.prepare(
    "SELECT COALESCE(MAX(ordinal), 0) AS max_ord FROM note_anchors WHERE clip_id = ?"
  ).get(noteId) as { max_ord: number };
  const nextOrdinal = maxRow.max_ord + 1;
  db.prepare(`
    INSERT INTO note_anchors (clip_id, ordinal, video_id, channel_id, start_seconds, end_seconds, excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    noteId,
    nextOrdinal,
    input.videoId,
    input.channelId,
    input.startSeconds ?? null,
    input.endSeconds ?? null,
    input.excerpt ?? null,
  );
  db.prepare("UPDATE transcript_clips SET updated_at = datetime('now') WHERE id = ?").run(noteId);
  return nextOrdinal;
}

/** Remove an anchor by ordinal. Notes with zero anchors are valid
 *  (standalone "just a thought" notes) — no minimum-anchor restriction. */
export function removeNoteAnchor(noteId: string, ordinal: number): boolean {
  const db = getDb();
  const removed = db.prepare(
    "DELETE FROM note_anchors WHERE clip_id = ? AND ordinal = ?"
  ).run(noteId, ordinal).changes > 0;
  if (removed) {
    db.prepare("UPDATE transcript_clips SET updated_at = datetime('now') WHERE id = ?").run(noteId);
  }
  return removed;
}

/** Re-mirror legacy single-anchor columns on transcript_clips from the
 *  current first anchor — invoke after add/remove so legacy readers keep
 *  showing something sensible. When zero anchors remain (standalone note),
 *  clears the legacy columns to NULL. */
export function syncLegacyAnchorColumns(noteId: string): void {
  const db = getDb();
  const first = db.prepare(`
    SELECT video_id, channel_id, start_seconds, end_seconds, excerpt
    FROM note_anchors WHERE clip_id = ?
    ORDER BY ordinal ASC LIMIT 1
  `).get(noteId) as { video_id: string; channel_id: string; start_seconds: number | null; end_seconds: number | null; excerpt: string | null } | undefined;
  db.prepare(`
    UPDATE transcript_clips
    SET video_id = ?, channel_id = ?, start_seconds = ?, end_seconds = ?, quote = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    first?.video_id ?? null,
    first?.channel_id ?? null,
    first?.start_seconds ?? null,
    first?.end_seconds ?? null,
    first?.excerpt ?? null,
    noteId,
  );
}

export function getTranscriptClip(id: string): TranscriptClip | undefined {
  const row = getDb().prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE clip.id = ?
  `).get(id) as Omit<TranscriptClip, "tags" | "anchors"> | undefined;
  if (!row) return undefined;
  return hydrateClips([row])[0];
}

/**
 * Filter clips. `tags` is an intersect filter — every listed tag must match
 * the clip, where matching is hierarchical: "religion" matches clips tagged
 * "religion" OR "religion.<anything>".
 */
export function listTranscriptClips(filters: {
  q?: string;
  channelId?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
} = {}): { rows: TranscriptClip[]; total: number } {
  const where: string[] = [];
  const params: any[] = [];

  if (filters.channelId && filters.channelId !== "all") {
    where.push("clip.channel_id = ?");
    params.push(filters.channelId);
  }
  if (filters.q?.trim()) {
    const like = `%${filters.q.trim()}%`;
    where.push(`(
      clip.title LIKE ?
      OR COALESCE(clip.channel_name, '') LIKE ?
      OR clip.quote LIKE ?
      OR COALESCE(clip.note, '') LIKE ?
      OR clip.upload_date LIKE ?
    )`);
    params.push(like, like, like, like, like);
  }

  const tagFilter = (filters.tags ?? [])
    .map(normalizeTag)
    .filter(t => t.length > 0);
  for (const tag of tagFilter) {
    where.push(`clip.id IN (
      SELECT clip_id FROM clip_tags WHERE tag = ? OR tag LIKE ? || '.%'
    )`);
    params.push(tag, tag);
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 100), 1), 250);
  const offset = Math.max(Math.floor(filters.offset ?? 0), 0);
  const fromSql = `
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
  `;
  const totalRow = getDb()
    .prepare(`SELECT COUNT(*) as count ${fromSql} ${whereSql}`)
    .get(...params) as { count: number } | undefined;

  const rows = getDb().prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status
    ${fromSql}
    ${whereSql}
    ORDER BY clip.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Omit<TranscriptClip, "tags" | "anchors">[];

  return { rows: hydrateClips(rows), total: totalRow?.count ?? 0 };
}

/**
 * Related clips for a video: split into "byTags" (clips from OTHER videos
 * sharing ≥1 tag with clips of the source video, ranked by overlap) and
 * "sameVideo" (clips from this video, the legacy behavior). Both lists
 * include their tag arrays so the UI can show match chips.
 */
export function listRelatedTranscriptClips(
  videoId: string,
  channelId: string,
  excludeId?: string,
): { byTags: (TranscriptClip & { overlap: number })[]; sameVideo: TranscriptClip[] } {
  const db = getDb();

  const sameVideoParams: any[] = [videoId, channelId];
  let excludeSql = "";
  if (excludeId) {
    excludeSql = "AND clip.id != ?";
    sameVideoParams.push(excludeId);
  }
  // "Same video" now means: a note has at least one anchor on this video.
  // Sourced from note_anchors so multi-anchor notes appear here whenever
  // ANY of their anchors lands on the requested video.
  const sameVideoRows = db.prepare(`
    SELECT DISTINCT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status,
      MIN(a.start_seconds) AS _anchor_start
    FROM transcript_clips clip
    JOIN note_anchors a ON a.clip_id = clip.id
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE a.video_id = ? AND a.channel_id = ?
    ${excludeSql}
    GROUP BY clip.id
    ORDER BY _anchor_start ASC, clip.created_at DESC
    LIMIT 50
  `).all(...sameVideoParams) as Omit<TranscriptClip, "tags" | "anchors">[];
  const sameVideo = hydrateClips(sameVideoRows);

  const sourceTags = (db.prepare(`
    SELECT DISTINCT t.tag
    FROM clip_tags t
    JOIN transcript_clips c ON c.id = t.clip_id
    WHERE c.video_id = ? AND c.channel_id = ?
  `).all(videoId, channelId) as { tag: string }[]).map(r => r.tag);

  if (!sourceTags.length) {
    return { byTags: [], sameVideo };
  }

  const tagPlaceholders = sourceTags.map(() => "?").join(",");
  // Exclude clips whose ONLY anchors land on the source video — avoids the
  // "same video" set bleeding into the cross-video "by tags" set. Anchors
  // are checked via NOT EXISTS rather than the legacy single-anchor column
  // so multi-anchor notes are scoped correctly.
  const byTagsRows = db.prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status,
      (
        SELECT COUNT(DISTINCT t.tag)
        FROM clip_tags t
        WHERE t.clip_id = clip.id AND t.tag IN (${tagPlaceholders})
      ) AS overlap
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE EXISTS (
        SELECT 1 FROM note_anchors a2
        WHERE a2.clip_id = clip.id
          AND NOT (a2.video_id = ? AND a2.channel_id = ?)
      )
      AND EXISTS (
        SELECT 1 FROM clip_tags t
        WHERE t.clip_id = clip.id AND t.tag IN (${tagPlaceholders})
      )
    ORDER BY overlap DESC, clip.created_at DESC
    LIMIT 50
  `).all(...sourceTags, videoId, channelId, ...sourceTags) as (Omit<TranscriptClip, "tags" | "anchors"> & { overlap: number })[];

  return {
    byTags: hydrateClips(byTagsRows) as (TranscriptClip & { overlap: number })[],
    sameVideo,
  };
}

export function deleteTranscriptClip(id: string): boolean {
  return getDb().prepare("DELETE FROM transcript_clips WHERE id = ?").run(id).changes > 0;
}


// ---- Clip links (manual, typed) ----

export const CLIP_LINK_KINDS = [
  "same_claim",
  "contradicts",
  "same_topic",
  "follow_up",
  "context",
] as const;

export type ClipLinkKind = (typeof CLIP_LINK_KINDS)[number];

const SYMMETRIC_LINK_KINDS = new Set<ClipLinkKind>(["same_claim", "contradicts", "same_topic"]);

export interface ClipLink {
  from_clip_id: string;
  to_clip_id: string;
  kind: ClipLinkKind;
  note: string | null;
  created_at: string;
}

export interface ClipLinkWithClip extends ClipLink {
  direction: "outgoing" | "incoming";
  other: TranscriptClip;
}

export function addClipLink(
  fromId: string,
  toId: string,
  kind: ClipLinkKind,
  note?: string | null,
): { inserted: number } {
  if (fromId === toId) throw new Error("A clip cannot link to itself");
  if (!CLIP_LINK_KINDS.includes(kind)) throw new Error(`Unknown link kind: ${kind}`);

  const cleanedNote = note?.trim() || null;
  const db = getDb();
  return db.transaction(() => {
    const main = db
      .prepare(`INSERT OR REPLACE INTO clip_links (from_clip_id, to_clip_id, kind, note) VALUES (?, ?, ?, ?)`)
      .run(fromId, toId, kind, cleanedNote);
    let inserted = main.changes;
    if (SYMMETRIC_LINK_KINDS.has(kind)) {
      const mirror = db
        .prepare(`INSERT OR REPLACE INTO clip_links (from_clip_id, to_clip_id, kind, note) VALUES (?, ?, ?, ?)`)
        .run(toId, fromId, kind, cleanedNote);
      inserted += mirror.changes;
    }
    return { inserted };
  })();
}

export function removeClipLink(fromId: string, toId: string, kind: ClipLinkKind): { removed: number } {
  const db = getDb();
  return db.transaction(() => {
    let removed = db
      .prepare("DELETE FROM clip_links WHERE from_clip_id = ? AND to_clip_id = ? AND kind = ?")
      .run(fromId, toId, kind).changes;
    if (SYMMETRIC_LINK_KINDS.has(kind)) {
      removed += db
        .prepare("DELETE FROM clip_links WHERE from_clip_id = ? AND to_clip_id = ? AND kind = ?")
        .run(toId, fromId, kind).changes;
    }
    return { removed };
  })();
}

/**
 * Returns links that involve the given clip, with the OTHER clip preloaded
 * (and its tags). Outgoing = `from_clip_id = clipId`. Incoming reverses the
 * pair. For symmetric kinds the `addClipLink` mirror means there's already
 * an outgoing row for the inverse, so the UI should only render outgoing
 * unless you explicitly want both — see `linkPanels` server-side helper.
 */
export function getClipLinks(clipId: string): ClipLinkWithClip[] {
  const db = getDb();
  const outgoing = db.prepare(`
    SELECT * FROM clip_links WHERE from_clip_id = ?
    ORDER BY kind, created_at DESC
  `).all(clipId) as ClipLink[];
  const incoming = db.prepare(`
    SELECT * FROM clip_links WHERE to_clip_id = ? AND from_clip_id != ?
    ORDER BY kind, created_at DESC
  `).all(clipId, clipId) as ClipLink[];

  const otherIds = new Set<string>();
  outgoing.forEach(l => otherIds.add(l.to_clip_id));
  incoming.forEach(l => otherIds.add(l.from_clip_id));

  if (otherIds.size === 0) return [];

  const ids = Array.from(otherIds);
  const placeholders = ids.map(() => "?").join(",");
  const otherClips = db.prepare(`
    SELECT
      clip.*,
      q.video_path,
      q.md_path,
      q.word_count,
      q.is_live,
      q.duration,
      q.status
    FROM transcript_clips clip
    LEFT JOIN video_queue q ON q.video_id = clip.video_id AND q.channel_id = clip.channel_id
    WHERE clip.id IN (${placeholders})
  `).all(...ids) as Omit<TranscriptClip, "tags">[];

  const withTags = attachTagsToClips(otherClips);
  const byId = new Map(withTags.map(c => [c.id, c]));

  const result: ClipLinkWithClip[] = [];
  for (const link of outgoing) {
    const other = byId.get(link.to_clip_id);
    if (other) result.push({ ...link, direction: "outgoing", other });
  }
  for (const link of incoming) {
    if (SYMMETRIC_LINK_KINDS.has(link.kind)) continue; // already counted via outgoing mirror
    const other = byId.get(link.from_clip_id);
    if (other) result.push({ ...link, direction: "incoming", other });
  }
  return result;
}

// ---- Clip graph (for /map) ----

export type GraphEdgeType = "manual" | "shared_tag" | "same_video";

export interface GraphNodeAnchor {
  ordinal: number;
  videoId: string;
  channelId: string;
  channelName: string | null;
  videoTitle: string | null;
  uploadDate: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
}

export interface GraphNode {
  id: string;
  clipId: string;
  videoId: string;
  channelId: string;
  channelName: string | null;
  title: string;
  uploadDate: string | null;
  startSeconds: number;
  endSeconds: number;
  quote: string;
  note: string | null;
  tags: string[];
  videoPath: string | null;
  mdPath: string | null;
  status: string;
  isLive: number;
  duration: number | null;
  degree: number;
  /** Anchor list for multi-anchor visualization. Always at least one entry
   *  for migrated single-anchor notes (mirrored from legacy columns).
   *  Empty for standalone notes (zero anchors). */
  anchors: GraphNodeAnchor[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: GraphEdgeType;
  label: string;
  weight: number;
  tags?: string[];
  manualKind?: ClipLinkKind;
  note?: string | null;
}

export interface ClipGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    tagCount: number;
    manualEdgeCount: number;
    sharedTagEdgeCount: number;
    sameVideoEdgeCount: number;
  };
}

export interface ClipMapLayoutNode {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const ALL_GRAPH_EDGE_TYPES: GraphEdgeType[] = ["manual", "shared_tag", "same_video"];

/** Tags whose membership exceeds this many candidate clips are skipped for
 *  shared-tag edges so dense tags don't produce O(N²) noise. */
const SHARED_TAG_DENSE_THRESHOLD = 20;
/** Hard cap on total shared-tag edges in a single response. */
const SHARED_TAG_MAX_EDGES = 1000;

/**
 * Layout-agnostic graph view of clips, tags, and links. Candidate clips are
 * the first `limit` clips matching the same filter set as the Clips page
 * (q, channelId, intersect tags with hierarchy). Edges are derived from:
 *
 *   - clip_links (manual, with kind label)
 *   - clip_tags  (shared-tag pairs, dense tags skipped, deduped by pair)
 *   - clip start_seconds within the same video (consecutive only)
 */
export function getClipGraph(filters: {
  q?: string;
  channelId?: string;
  tags?: string[];
  edgeTypes?: GraphEdgeType[];
  limit?: number;
} = {}): ClipGraph {
  const limit = Math.min(Math.max(Math.floor(filters.limit ?? 150), 1), 500);
  const requestedTypes = filters.edgeTypes && filters.edgeTypes.length
    ? filters.edgeTypes.filter((t): t is GraphEdgeType => ALL_GRAPH_EDGE_TYPES.includes(t))
    : ALL_GRAPH_EDGE_TYPES;
  const edgeTypes = new Set<GraphEdgeType>(requestedTypes);

  const { rows: clips } = listTranscriptClips({
    q: filters.q,
    channelId: filters.channelId,
    tags: filters.tags,
    limit,
    offset: 0,
  });

  if (!clips.length) {
    return {
      nodes: [],
      edges: [],
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        tagCount: 0,
        manualEdgeCount: 0,
        sharedTagEdgeCount: 0,
        sameVideoEdgeCount: 0,
      },
    };
  }

  const clipIds = clips.map(c => c.id);
  const placeholders = clipIds.map(() => "?").join(",");
  const db = getDb();
  const edges: GraphEdge[] = [];
  let manualEdgeCount = 0;
  let sharedTagEdgeCount = 0;
  let sameVideoEdgeCount = 0;

  // Manual edges from clip_links. Symmetric kinds were stored as mirrored
  // rows on insert, so we dedupe to one undirected edge per (pair, kind).
  // Asymmetric kinds (follow_up, context) keep their direction.
  if (edgeTypes.has("manual")) {
    const links = db.prepare(`
      SELECT * FROM clip_links
      WHERE from_clip_id IN (${placeholders})
        AND to_clip_id IN (${placeholders})
    `).all(...clipIds, ...clipIds) as ClipLink[];

    const seenSymmetric = new Set<string>();
    for (const link of links) {
      if (SYMMETRIC_LINK_KINDS.has(link.kind)) {
        const [a, b] = link.from_clip_id < link.to_clip_id
          ? [link.from_clip_id, link.to_clip_id]
          : [link.to_clip_id, link.from_clip_id];
        const key = `${a}|${b}|${link.kind}`;
        if (seenSymmetric.has(key)) continue;
        seenSymmetric.add(key);
        edges.push({
          id: `manual:${a}:${b}:${link.kind}`,
          source: a,
          target: b,
          kind: "manual",
          label: link.kind,
          weight: 1,
          manualKind: link.kind,
          note: link.note,
        });
      } else {
        edges.push({
          id: `manual:${link.from_clip_id}:${link.to_clip_id}:${link.kind}`,
          source: link.from_clip_id,
          target: link.to_clip_id,
          kind: "manual",
          label: link.kind,
          weight: 1,
          manualKind: link.kind,
          note: link.note,
        });
      }
      manualEdgeCount += 1;
    }
  }

  // Shared-tag edges. Group candidates by tag, generate undirected pairs,
  // skip tags that match too many candidates (dense → O(N²) explosion),
  // dedupe pairs across tags by accumulating tag set + weight.
  if (edgeTypes.has("shared_tag")) {
    const tagRows = db.prepare(`
      SELECT clip_id, tag FROM clip_tags WHERE clip_id IN (${placeholders})
    `).all(...clipIds) as { clip_id: string; tag: string }[];

    const clipsByTag = new Map<string, string[]>();
    for (const row of tagRows) {
      const list = clipsByTag.get(row.tag);
      if (list) list.push(row.clip_id);
      else clipsByTag.set(row.tag, [row.clip_id]);
    }

    const sharedByPair = new Map<string, { weight: number; tags: Set<string> }>();
    Array.from(clipsByTag.entries()).forEach(([tag, ids]) => {
      if (ids.length > SHARED_TAG_DENSE_THRESHOLD) return;
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
          const key = `${a}|${b}`;
          const acc = sharedByPair.get(key);
          if (acc) {
            acc.weight += 1;
            acc.tags.add(tag);
          } else {
            sharedByPair.set(key, { weight: 1, tags: new Set([tag]) });
          }
        }
      }
    });

    const ranked = Array.from(sharedByPair.entries())
      .sort((a, b) => b[1].weight - a[1].weight)
      .slice(0, SHARED_TAG_MAX_EDGES);

    for (const [key, acc] of ranked) {
      const [source, target] = key.split("|");
      const tagList = Array.from(acc.tags).sort();
      const label = tagList.length === 1 ? tagList[0] : `${tagList.length} shared tags`;
      edges.push({
        id: `shared_tag:${source}:${target}`,
        source,
        target,
        kind: "shared_tag",
        label,
        weight: acc.weight,
        tags: tagList,
      });
      sharedTagEdgeCount += 1;
    }
  }

  // Same-video adjacency. Now anchor-aware: within each (channel_id, video_id)
  // bucket, all of a clip's anchors that touch this video count as anchor
  // points — multi-anchor notes can show up in multiple buckets, and any
  // pair sharing a bucket gets connected. Sorting by anchor start gives a
  // deterministic order; we connect consecutive pairs to keep edge count
  // O(N) rather than O(N²) within a busy video.
  if (edgeTypes.has("same_video")) {
    type AnchorPoint = { clipId: string; startSeconds: number };
    const byVideo = new Map<string, AnchorPoint[]>();
    for (const clip of clips) {
      // Iterate every anchor (multi-anchor notes contribute multiple points)
      // — fall back to the legacy single-anchor columns when anchors[] is
      // empty (defensive: should not happen post-Phase-1 backfill).
      const points = clip.anchors?.length
        ? clip.anchors.map((a) => ({
            videoKey: `${a.channel_id}|${a.video_id}`,
            startSeconds: a.start_seconds ?? 0,
          }))
        : [{
            videoKey: `${clip.channel_id}|${clip.video_id}`,
            startSeconds: clip.start_seconds,
          }];
      for (const p of points) {
        const list = byVideo.get(p.videoKey);
        const point: AnchorPoint = { clipId: clip.id, startSeconds: p.startSeconds };
        if (list) list.push(point);
        else byVideo.set(p.videoKey, [point]);
      }
    }
    const seenPair = new Set<string>();
    Array.from(byVideo.values()).forEach((list) => {
      if (list.length < 2) return;
      list.sort((a, b) => a.startSeconds - b.startSeconds);
      for (let i = 0; i < list.length - 1; i += 1) {
        const a = list[i];
        const b = list[i + 1];
        if (a.clipId === b.clipId) continue; // same note's two anchors in one video
        const key = a.clipId < b.clipId ? `${a.clipId}:${b.clipId}` : `${b.clipId}:${a.clipId}`;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        edges.push({
          id: `same_video:${key}`,
          source: a.clipId,
          target: b.clipId,
          kind: "same_video",
          label: "same video",
          weight: 1,
        });
        sameVideoEdgeCount += 1;
      }
    });
  }

  const degreeByClip = new Map<string, number>();
  for (const edge of edges) {
    degreeByClip.set(edge.source, (degreeByClip.get(edge.source) ?? 0) + 1);
    degreeByClip.set(edge.target, (degreeByClip.get(edge.target) ?? 0) + 1);
  }

  const nodes: GraphNode[] = clips.map(c => ({
    id: c.id,
    clipId: c.id,
    videoId: c.video_id,
    channelId: c.channel_id,
    channelName: c.channel_name,
    title: c.title,
    uploadDate: c.upload_date,
    startSeconds: c.start_seconds,
    endSeconds: c.end_seconds,
    quote: c.quote,
    note: c.note,
    tags: c.tags,
    videoPath: c.video_path,
    mdPath: c.md_path,
    status: c.status,
    isLive: c.is_live,
    duration: c.duration,
    degree: degreeByClip.get(c.id) ?? 0,
    anchors: (c.anchors ?? []).map((a) => ({
      ordinal: a.ordinal,
      videoId: a.video_id,
      channelId: a.channel_id,
      channelName: a.channel_name,
      videoTitle: a.video_title,
      uploadDate: a.upload_date,
      startSeconds: a.start_seconds,
      endSeconds: a.end_seconds,
    })),
  }));

  const tagSet = new Set<string>();
  for (const node of nodes) {
    for (const tag of node.tags) tagSet.add(tag);
  }

  return {
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      tagCount: tagSet.size,
      manualEdgeCount,
      sharedTagEdgeCount,
      sameVideoEdgeCount,
    },
  };
}

export function getClipMapLayout(mapKey: string): ClipMapLayoutNode[] {
  const rows = getDb().prepare(`
    SELECT node_id, x, y, width, height
    FROM clip_map_layouts
    WHERE map_key = ?
  `).all(mapKey) as { node_id: string; x: number; y: number; width: number; height: number }[];

  return rows.map(row => ({
    nodeId: row.node_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
  }));
}

export function saveClipMapLayout(mapKey: string, nodes: ClipMapLayoutNode[]): { saved: number } {
  const cleaned = nodes.filter(node =>
    node.nodeId &&
    Number.isFinite(node.x) &&
    Number.isFinite(node.y) &&
    Number.isFinite(node.width) &&
    Number.isFinite(node.height),
  );

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO clip_map_layouts (map_key, node_id, x, y, width, height, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(map_key, node_id) DO UPDATE SET
      x = excluded.x,
      y = excluded.y,
      width = excluded.width,
      height = excluded.height,
      updated_at = datetime('now')
  `);

  db.transaction(() => {
    for (const node of cleaned) {
      upsert.run(mapKey, node.nodeId, node.x, node.y, node.width, node.height);
    }
  })();

  return { saved: cleaned.length };
}



