import { getDb } from "./db";

// ---------------------------------------------------------------
// AI chat persistence helpers
//
// Three tables, all created in the SCHEMA constant in db.ts:
//   chat_conversations    — one row per chat. Pinned bit, title (auto-derived
//                            from the first question, user-editable).
//   chat_messages         — user + assistant turns. is_starred flag on
//                            assistants for "this answer was useful."
//   chat_message_sources  — N rows per assistant message, one per [N]
//                            citation. Stable references (video_id, channel_id,
//                            segment_index, start/end, excerpt, score) so the
//                            answer's grounding survives even if vec_segments
//                            is later wiped or re-embedded. Playback metadata
//                            (video_path / md_path / status / etc.) is NOT
//                            stored — it's re-joined on read from video_queue
//                            so paths stay current.
// ---------------------------------------------------------------

export interface ChatConversationMeta {
  id: string;
  title: string | null;
  pinned: boolean;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  is_starred: boolean;
  created_at: string;
  sources: ChatMessageSource[];
}

export interface ChatMessageSource {
  source_index: number;
  /** "video" (default) or "doc". Discriminator for the doc-source
   *  fields below; old persisted rows read back as "video" via
   *  COALESCE. */
  source: string;
  video_id: string;
  channel_id: string;
  segment_index: number | null;
  start_seconds: number | null;
  end_seconds: number | null;
  speaker: string | null;
  speaker_name: string | null;     // resolved from speakers table when available
  excerpt: string | null;
  score: number | null;
  video_title: string | null;       // joined from video_queue
  channel_name: string | null;      // joined from channels
  upload_date: string | null;
  /** Playback metadata, re-resolved on read (not stored in chat_message_sources
   *  — state can drift). Lets the client open the VideoDrawer at the cited
   *  timestamp without an extra round-trip. */
  video_path: string | null;
  md_path: string | null;
  status: string | null;
  is_live: number | null;
  duration: number | null;
  word_count: number | null;
  /** Doc-source fields — populated when source === "doc". */
  document_id: string | null;
  doc_chunk_index: number | null;
  doc_start_char: number | null;
  doc_end_char: number | null;
  doc_heading_path: string | null;
  doc_rel_path: string | null;
  doc_title: string | null;
  /** Empty string for the legacy root; the configured root id
   *  otherwise. Joined from documents.root_id on read — chat_
   *  message_sources doesn't store it. */
  doc_root_id: string | null;
}

export interface ChatConversationDetail extends ChatConversationMeta {
  messages: ChatMessage[];
}

export function listChatConversations(): ChatConversationMeta[] {
  return getDb().prepare(`
    SELECT
      c.id,
      c.title,
      c.pinned,
      c.created_at,
      c.updated_at,
      COUNT(m.id) AS message_count,
      MAX(m.created_at) AS last_message_at
    FROM chat_conversations c
    LEFT JOIN chat_messages m ON m.conversation_id = c.id
    GROUP BY c.id
    ORDER BY c.pinned DESC, COALESCE(MAX(m.created_at), c.created_at) DESC
  `).all().map((r: any) => ({
    id: r.id,
    title: r.title,
    pinned: !!r.pinned,
    message_count: r.message_count ?? 0,
    last_message_at: r.last_message_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export function createChatConversation(args: { id: string; title?: string | null }): ChatConversationMeta {
  getDb().prepare(`
    INSERT INTO chat_conversations (id, title) VALUES (?, ?)
  `).run(args.id, args.title ?? null);
  return getChatConversationMeta(args.id)!;
}

export function getChatConversationMeta(id: string): ChatConversationMeta | undefined {
  const row = getDb().prepare(`
    SELECT
      c.id, c.title, c.pinned, c.created_at, c.updated_at,
      COUNT(m.id) AS message_count,
      MAX(m.created_at) AS last_message_at
    FROM chat_conversations c
    LEFT JOIN chat_messages m ON m.conversation_id = c.id
    WHERE c.id = ?
    GROUP BY c.id
  `).get(id) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    title: row.title,
    pinned: !!row.pinned,
    message_count: row.message_count ?? 0,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getChatConversation(id: string): ChatConversationDetail | undefined {
  const meta = getChatConversationMeta(id);
  if (!meta) return undefined;

  const messages = getDb().prepare(`
    SELECT id, conversation_id, role, content, model, is_starred, created_at
    FROM chat_messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(id) as Array<Omit<ChatMessage, "is_starred" | "sources"> & { is_starred: number }>;

  if (messages.length === 0) {
    return { ...meta, messages: [] };
  }

  // Bulk-load sources for all messages in one query — joined to video_queue
  // and channels so each source has display-friendly metadata.
  const ids = messages.map(m => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const sourceRows = getDb().prepare(`
    SELECT
      s.message_id, s.source_index, s.video_id, s.channel_id,
      s.segment_index, s.start_seconds, s.end_seconds, s.speaker,
      s.excerpt, s.score,
      q.title AS video_title, q.upload_date,
      q.video_path, q.md_path, q.status, q.is_live, q.duration, q.word_count,
      c.name  AS channel_name,
      sp.name AS speaker_name,
      COALESCE(s.source, 'video') AS source,
      s.document_id, s.doc_chunk_index, s.doc_start_char, s.doc_end_char,
      s.doc_heading_path,
      d.rel_path AS doc_rel_path, d.title AS doc_title,
      COALESCE(d.root_id, '') AS doc_root_id
    FROM chat_message_sources s
    LEFT JOIN video_queue q ON q.video_id = s.video_id AND q.channel_id = s.channel_id
    LEFT JOIN channels    c ON c.id       = s.channel_id
    LEFT JOIN video_speaker_assignments vsa
           ON vsa.video_id = s.video_id
          AND vsa.channel_id = s.channel_id
          AND vsa.local_speaker = s.speaker
    LEFT JOIN speakers sp ON sp.id = vsa.speaker_id
    LEFT JOIN documents d  ON d.id        = s.document_id
    WHERE s.message_id IN (${placeholders})
    ORDER BY s.message_id, s.source_index ASC
  `).all(...ids) as Array<ChatMessageSource & { message_id: string }>;

  const byMessage = new Map<string, ChatMessageSource[]>();
  for (const s of sourceRows) {
    const { message_id, ...source } = s;
    const list = byMessage.get(message_id);
    if (list) list.push(source); else byMessage.set(message_id, [source]);
  }

  return {
    ...meta,
    messages: messages.map(m => ({
      ...m,
      is_starred: !!m.is_starred,
      sources: byMessage.get(m.id) ?? [],
    })),
  };
}

export function deleteChatConversation(id: string): boolean {
  return getDb().prepare("DELETE FROM chat_conversations WHERE id = ?").run(id).changes > 0;
}

export function updateChatConversation(id: string, fields: { title?: string | null; pinned?: boolean }): ChatConversationMeta | undefined {
  const sets: string[] = [];
  const params: any[] = [];
  if (fields.title !== undefined) { sets.push("title = ?"); params.push(fields.title); }
  if (fields.pinned !== undefined) { sets.push("pinned = ?"); params.push(fields.pinned ? 1 : 0); }
  if (sets.length === 0) return getChatConversationMeta(id);
  sets.push("updated_at = datetime('now')");
  params.push(id);
  getDb().prepare(`UPDATE chat_conversations SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getChatConversationMeta(id);
}

export function appendChatMessage(args: {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  model?: string | null;
  sources?: Array<{
    sourceIndex: number;
    source?: "video" | "doc";
    videoId: string;
    channelId: string;
    segmentIndex?: number | null;
    startSeconds?: number | null;
    endSeconds?: number | null;
    speaker?: string | null;
    excerpt?: string | null;
    score?: number | null;
    documentId?: string | null;
    docStartChar?: number | null;
    docEndChar?: number | null;
    docHeadingPath?: string | null;
  }>;
}): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, model)
      VALUES (?, ?, ?, ?, ?)
    `).run(args.id, args.conversationId, args.role, args.content, args.model ?? null);

    if (args.sources?.length) {
      const insert = db.prepare(`
        INSERT INTO chat_message_sources
          (message_id, source_index, video_id, channel_id, segment_index,
           start_seconds, end_seconds, speaker, excerpt, score,
           source, document_id, doc_chunk_index, doc_start_char, doc_end_char,
           doc_heading_path)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of args.sources) {
        insert.run(
          args.id, s.sourceIndex, s.videoId, s.channelId,
          s.segmentIndex ?? null, s.startSeconds ?? null, s.endSeconds ?? null,
          s.speaker ?? null, s.excerpt ?? null, s.score ?? null,
          s.source ?? "video",
          s.documentId ?? null,
          // doc_chunk_index reuses the segment_index slot conceptually,
          // but keep a dedicated column so future schema changes don't
          // need to coalesce.
          s.source === "doc" ? (s.segmentIndex ?? null) : null,
          s.docStartChar ?? null, s.docEndChar ?? null,
          s.docHeadingPath ?? null,
        );
      }
    }

    db.prepare(`
      UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?
    `).run(args.conversationId);
  })();
}

export function setChatMessageStarred(messageId: string, starred: boolean): boolean {
  const r = getDb().prepare(
    "UPDATE chat_messages SET is_starred = ? WHERE id = ?"
  ).run(starred ? 1 : 0, messageId);
  return r.changes > 0;
}

export function getChatMessage(id: string): ChatMessage | undefined {
  const row = getDb().prepare(`
    SELECT id, conversation_id, role, content, model, is_starred, created_at
    FROM chat_messages WHERE id = ?
  `).get(id) as any;
  if (!row) return undefined;
  const sourceRows = getDb().prepare(`
    SELECT
      s.source_index, s.video_id, s.channel_id, s.segment_index,
      s.start_seconds, s.end_seconds, s.speaker, s.excerpt, s.score,
      q.title AS video_title, q.upload_date,
      q.video_path, q.md_path, q.status, q.is_live, q.duration, q.word_count,
      c.name  AS channel_name,
      sp.name AS speaker_name,
      COALESCE(s.source, 'video') AS source,
      s.document_id, s.doc_chunk_index, s.doc_start_char, s.doc_end_char,
      s.doc_heading_path,
      d.rel_path AS doc_rel_path, d.title AS doc_title,
      COALESCE(d.root_id, '') AS doc_root_id
    FROM chat_message_sources s
    LEFT JOIN video_queue q ON q.video_id = s.video_id AND q.channel_id = s.channel_id
    LEFT JOIN channels    c ON c.id       = s.channel_id
    LEFT JOIN video_speaker_assignments vsa
           ON vsa.video_id = s.video_id
          AND vsa.channel_id = s.channel_id
          AND vsa.local_speaker = s.speaker
    LEFT JOIN speakers sp ON sp.id = vsa.speaker_id
    LEFT JOIN documents d  ON d.id        = s.document_id
    WHERE s.message_id = ?
    ORDER BY s.source_index ASC
  `).all(id) as ChatMessageSource[];
  return {
    ...row,
    is_starred: !!row.is_starred,
    sources: sourceRows,
  };
}
