import { searchSemantic, type SemanticSearchResult } from "./semantic-search";
import { chat, chatStream } from "./llm";
import { getDb, searchTranscriptSegments, videoKind, type ChatMessage as PersistedChatMessage } from "./db";

/**
 * RAG chat orchestrator. Pipeline per turn:
 *   1. Embed the user's question (via searchSemantic which calls embed())
 *   2. Top-K cosine search against vec_segments
 *   3. Per-video diversity cap so a focused query doesn't return 8
 *      adjacent segments from one video and starve the model of breadth
 *   4. Build a numbered context block (sources [1], [2], ...) plus a
 *      system prompt that constrains the answer to those sources
 *   5. Stream the chat model's response as token deltas
 *
 * Yields events as a discriminated union so the route handler can map
 * them 1:1 to SSE frames.
 */

export interface AskArchiveArgs {
  question: string;
  /** Optional prior turns for multi-turn context (last N exchanges). v1
   *  passes them verbatim to the chat model — good enough for "tell me
   *  more" follow-ups; query rewriting is a v2 upgrade. */
  history?: Pick<PersistedChatMessage, "role" | "content">[];
  /** When set, restrict retrieval to these channels. */
  channelIds?: string[];
  /** Personal / work scope — narrows retrieval to videos in the
   *  matching category. Passed through to both semantic + FTS
   *  candidate searches. */
  category?: string;
  /** Source-kind scope. Selects any combination of audio (file ext
   *  .wav/.m4a/.mp3/...), video (.mp4/.mkv/...), and doc (markdown
   *  chunks). Missing/empty means "all kinds". */
  sources?: ("video" | "audio" | "doc")[];
  /** How many segments to retrieve. Default 18, capped at 50. */
  topK?: number;
  /** Cap segments per video so one source doesn't dominate the context. */
  perVideoCap?: number;
  /** Override the embedding model (defaults to configured llm.embeddingModel). */
  embeddingModel?: string;
  /** Override the chat model (defaults to configured llm.chatModel). */
  chatModel?: string;
  /** Optional abort signal — cancels both the LLM call and downstream stream. */
  signal?: AbortSignal;
}

export interface ContextSource {
  /** 1-based — matches the [N] markers the model is asked to emit. */
  sourceIndex: number;
  /** Source discriminator. Defaults to "video" for back-compat with
   *  persisted rows that predate doc sources. */
  source?: "video" | "doc";
  videoId: string;
  channelId: string;
  segmentIndex: number;
  startSeconds: number;
  endSeconds: number;
  speaker: string | null;
  /** Global speaker name resolved via video_speaker_assignments →
   *  speakers. Null when the local speaker hasn't been labeled yet.
   *  Sent to the LLM prompt in preference to the local "S0" label so
   *  the model can attribute quotes by name. */
  speakerName: string | null;
  excerpt: string;
  score: number;
  videoTitle: string;
  channelName: string | null;
  uploadDate: string | null;
  /** Playback metadata mirrored from video_queue so the client can hand
   *  the source straight to the VideoDrawer without a round-trip. Omitted
   *  from chat_message_sources persistence (state can change) — re-resolved
   *  on conversation reload via the same JOIN. */
  videoPath: string | null;
  mdPath: string | null;
  status: string | null;
  isLive: number | null;
  duration: number | null;
  wordCount: number | null;
  /** Doc-source fields — populated when source === "doc". The video*
   *  fields above are placeholders ("") in that case. */
  documentId?: string;
  /** Which root the doc lives in. Needed by the client when more
   *  than one root is configured — without it the file fetch falls
   *  back to the first root and 404s for docs in other roots.
   *  Empty string = legacy root. */
  docRootId?: string;
  docRelPath?: string;
  docTitle?: string;
  docHeadingPath?: string;
  docStartChar?: number;
  docEndChar?: number;
}

export type AskEvent =
  | { type: "context"; sources: ContextSource[]; weakRetrieval: boolean }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; error: string };

const RELEVANT_SCORE_FLOOR = 0.4;

function hardCap(n: number, max: number) {
  return Math.max(1, Math.min(Math.floor(n), max));
}

/** Diversity cap: keep at most `perVideoCap` segments per (video, channel)
 *  while preserving the original score-sorted order. */
/** Pull every global speaker name once per ask. Tiny table (≤ low
 *  hundreds of rows in practice); a cache would be premature.
 *  Returns lowercased names so the substring match below is
 *  case-insensitive without per-comparison toLowerCase. */
function listGlobalSpeakerNames(): { name: string; lower: string }[] {
  const rows = getDb()
    .prepare("SELECT name FROM speakers WHERE name IS NOT NULL AND name <> ''")
    .all() as { name: string }[];
  return rows.map((r) => ({ name: r.name, lower: r.name.toLowerCase() }));
}

/** Word-boundary match for each known speaker name against the
 *  user's question. Returns the ORIGINAL-case names that matched.
 *  Word-boundary so "Brandon" doesn't accidentally match "brandons"
 *  (or arbitrary substrings inside other words). */
function matchSpeakerNamesInQuestion(
  question: string,
  speakers: { name: string; lower: string }[],
): string[] {
  if (speakers.length === 0) return [];
  // Normalize punctuation to spaces (any non-alphanumeric, non-space
  // char), collapse runs, pad — gives us reliable word-boundary
  // checks via plain substring against " name ". The /u flag isn't
  // needed here; ASCII coverage is fine for English speaker names.
  const padded = ` ${question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim()} `;
  const out: string[] = [];
  for (const sp of speakers) {
    if (padded.includes(` ${sp.lower} `)) out.push(sp.name);
  }
  return out;
}

/** Key for deduplicating results across the primary + speaker-
 *  expansion passes. Doc hits use document_id + chunk; video hits
 *  use video/channel/segment. */
function speakerHitKey(r: SemanticSearchResult): string {
  if (r.source === "doc") return `doc:${r.document_id ?? ""}:${r.segment_index}`;
  return `vid:${r.video_id}:${r.channel_id}:${r.segment_index}`;
}

function applyPerVideoCap(rows: SemanticSearchResult[], perVideoCap: number): SemanticSearchResult[] {
  const counts = new Map<string, number>();
  const out: SemanticSearchResult[] = [];
  for (const r of rows) {
    // Doc hits cap per document_id; video hits per (video, channel).
    // Without the source split, every doc chunk would collide on the
    // empty (videoId, channelId) sentinel and only one would survive.
    const key = r.source === "doc"
      ? `doc:${r.document_id ?? ""}`
      : `video:${r.video_id}|${r.channel_id}`;
    const seen = counts.get(key) ?? 0;
    if (seen >= perVideoCap) continue;
    counts.set(key, seen + 1);
    out.push(r);
  }
  return out;
}

function formatSourceBlock(sources: ContextSource[]): string {
  return sources.map((s) => {
    if (s.source === "doc") {
      const heading = s.docHeadingPath ? ` · ${s.docHeadingPath}` : "";
      return `[${s.sourceIndex}] DOC: ${s.docTitle || s.docRelPath}${heading}\n${s.excerpt}`;
    }
    // Prefer the global speaker name when the user has labeled it —
    // the local "S0" / "S1" labels are meaningless to the model and
    // produce attribution mistakes like "attributed to Speaker S0".
    // Fall back to the local label when the speaker hasn't been
    // identified yet.
    const speakerLabel = s.speakerName ?? s.speaker;
    const speaker = speakerLabel ? ` · Speaker: ${speakerLabel}` : "";
    const ts = `${formatTimestamp(s.startSeconds)}–${formatTimestamp(s.endSeconds)}`;
    const date = s.uploadDate ? ` (${s.uploadDate})` : "";
    const channel = s.channelName ? `${s.channelName} · ` : "";
    return `[${s.sourceIndex}] ${channel}${s.videoTitle}${date}${speaker} · ${ts}\n${s.excerpt}`;
  }).join("\n\n");
}

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const SYSTEM_PROMPT = `You are an assistant for a personal research archive of YouTube video transcripts. You will be given relevant excerpts from videos in the archive, then a question.

Rules:
- Answer based ONLY on the provided excerpts. Do not bring in outside knowledge.
- Cite supporting excerpts with [N] markers where N is the source number. Combine multiple cites like [1, 3].
- If the excerpts don't actually answer the question, say "The archive doesn't have content that addresses this directly." Do not invent.
- Be concise. Lead with the answer; expand only if useful.
- When attributing claims to a person, use the speaker name shown for that excerpt when available; otherwise refer to the channel name.`;

const REWRITE_SYSTEM_PROMPT = `You convert a follow-up question into a complete, standalone question that captures the conversational context. The output is used as a search query against a video archive.

Rules:
- Output ONLY the rewritten question, no preamble, no quotes, no explanation.
- Preserve named entities, topics, and specific details from the prior turns.
- If the user's question is already standalone, return it unchanged.
- Keep it concise — under 30 words.`;

async function rewriteForRetrieval(
  question: string,
  history: Pick<PersistedChatMessage, "role" | "content">[],
  chatModel: string | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  if (!history.length) return question;
  const lower = question.toLowerCase().trim();
  const looksDependent =
    lower.length < 25 ||
    /^(it|that|this|those|these|they|he|she|him|her|them)\b/.test(lower) ||
    /\b(more|another|else|too|also|next|then|why|how about)\b/.test(lower) ||
    !/\b(what|who|when|where|how|did|does|do|is|are|was|were|can|could|would|should|might|may|will)\b/.test(lower);

  if (!looksDependent) return question;

  try {
    const messages = [
      { role: "system" as const, content: REWRITE_SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: `Follow-up: ${question}\n\nStandalone question:` },
    ];
    const out = await chat({ messages, model: chatModel, temperature: 0, maxTokens: 200, signal });
    const rewritten = out.replace(/^[\s"']+|[\s"']+$/g, "").trim();
    if (!rewritten || rewritten.length > Math.max(200, question.length * 4)) return question;
    return rewritten;
  } catch {
    return question;
  }
}

function rankFuse(
  semantic: SemanticSearchResult[],
  fts: SemanticSearchResult[],
  limit: number,
): SemanticSearchResult[] {
  const K = 60;
  const score = new Map<string, { row: SemanticSearchResult; score: number }>();
  const add = (rows: SemanticSearchResult[]) => {
    rows.forEach((r, idx) => {
      const key = `${r.video_id}|${r.channel_id}|${r.segment_index}`;
      const existing = score.get(key);
      const add = 1 / (K + idx + 1);
      if (existing) existing.score += add;
      else score.set(key, { row: r, score: add });
    });
  };
  add(semantic);
  add(fts);
  return Array.from(score.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((e) => e.row);
}

function ftsCandidates(
  query: string,
  channelIds: string[] | undefined,
  limit: number,
  category?: string,
): SemanticSearchResult[] {
  const rows = searchTranscriptSegments(query, {
    limit,
    channelId: channelIds && channelIds.length === 1 ? channelIds[0] : undefined,
    category,
  });
  const allowed = channelIds && channelIds.length > 1 ? new Set(channelIds) : null;
  return rows
    .filter((r) => !allowed || allowed.has(r.channel_id))
    .map((r) => ({
      ...r,
      score: 1 / (1 + Math.max(0, r.rank)),
    }));
}

export async function* askArchive(args: AskArchiveArgs): AsyncGenerator<AskEvent, void, void> {
  const topK = hardCap(args.topK ?? 18, 50);
  const perVideoCap = hardCap(args.perVideoCap ?? 3, 10);

  // If we have history, ask the chat model to rewrite a vague follow-up
  // as a standalone question. The standalone form goes to retrieval;
  // the original goes to the answer prompt so the user's phrasing is
  // preserved in the conversation flow.
  const retrievalQuery = await rewriteForRetrieval(
    args.question,
    args.history ?? [],
    args.chatModel,
    args.signal,
  );

  let semanticCandidates: SemanticSearchResult[] = [];
  try {
    const baseFilters = {
      ...(args.channelIds && args.channelIds.length === 1 ? { channelId: args.channelIds[0] } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(args.sources && args.sources.length > 0 ? { sources: args.sources } : {}),
    };

    // Pass 1: the original (or rewritten-for-retrieval) query.
    const primary = await searchSemantic({
      query: retrievalQuery,
      model: args.embeddingModel || "",
      limit: topK * 2,
      minScore: 0.3,
      filters: baseFilters,
    });
    semanticCandidates = primary.results;

    // Pass 2: speaker-aware expansion. Segments are now embedded
    // with the speaker's global name prefixed ("Brandon Biggs: …");
    // when the user's question mentions a known speaker by name we
    // run an extra KNN with the same prefix applied to the QUERY
    // side. That pushes the cosine math to favor the prefixed
    // segments — i.e. the speaker's own first-person content. Merge
    // by best score per (video, channel, segment) so duplicates from
    // pass 1 don't crowd the limit.
    const speakerNames = listGlobalSpeakerNames();
    const matchedNames = matchSpeakerNamesInQuestion(args.question, speakerNames);
    if (matchedNames.length > 0) {
      const merged = new Map<string, SemanticSearchResult>();
      for (const r of semanticCandidates) merged.set(speakerHitKey(r), r);
      for (const name of matchedNames) {
        try {
          const extra = await searchSemantic({
            query: `${name}: ${retrievalQuery}`,
            model: args.embeddingModel || "",
            limit: topK * 2,
            minScore: 0.3,
            filters: baseFilters,
          });
          for (const r of extra.results) {
            const key = speakerHitKey(r);
            const existing = merged.get(key);
            if (!existing || r.score > existing.score) {
              merged.set(key, r);
            }
          }
        } catch (err) {
          // Best-effort — a failed expansion shouldn't sink the whole ask.
          console.warn(`[ask] speaker-expansion for "${name}" failed:`, err instanceof Error ? err.message : err);
        }
      }
      semanticCandidates = Array.from(merged.values()).sort((a, b) => b.score - a.score);
    }
  } catch (err) {
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
    return;
  }

  if (args.channelIds && args.channelIds.length > 1) {
    const allowed = new Set(args.channelIds);
    semanticCandidates = semanticCandidates.filter((r) => allowed.has(r.channel_id));
  }

  // Hybrid: blend in FTS5 keyword hits via Reciprocal Rank Fusion. Catches
  // named entities and exact phrases that the embedding model can't
  // differentiate (e.g. proper nouns). FTS errors are silent — if the index
  // is missing or the query has no parseable terms, fall back to semantic-only.
  // Skip FTS entirely when the source scope excludes both video kinds —
  // FTS only knows about transcript segments, so there's nothing it can
  // contribute when the user asked for docs-only.
  const sourceSet = args.sources && args.sources.length > 0 ? new Set(args.sources) : null;
  const wantsAnyTranscript = !sourceSet || sourceSet.has("video") || sourceSet.has("audio");
  let ftsRows: SemanticSearchResult[] = [];
  if (wantsAnyTranscript) {
    try {
      ftsRows = ftsCandidates(retrievalQuery, args.channelIds, topK * 2, args.category);
      // Filter by kind when only one of video/audio is selected.
      if (sourceSet && !(sourceSet.has("video") && sourceSet.has("audio"))) {
        ftsRows = ftsRows.filter((r) => {
          const k = videoKind(r.video_path);
          if (k === "video") return sourceSet.has("video");
          if (k === "audio") return sourceSet.has("audio");
          return true; // unknown extension — keep
        });
      }
    } catch {
      ftsRows = [];
    }
  }

  const fused = ftsRows.length > 0
    ? rankFuse(semanticCandidates, ftsRows, topK * 2)
    : semanticCandidates;

  const capped = applyPerVideoCap(fused, perVideoCap).slice(0, topK);

  // Neighbor expansion. For each video-source hit, pull the
  // ±NEIGHBOR_WINDOW adjacent transcript segments from the same
  // video and inject them as context rows. The retrieval embedding
  // ranks chunks individually, but a lot of substantive content
  // (extended metaphors, multi-segment explanations, prophetic
  // imagery) only makes sense across consecutive segments. Without
  // expansion the LLM sees one cryptic line ("Your thing became a
  // pillar on my pillar") in isolation and can't recognize that the
  // surrounding 5-6 segments are about networks merging.
  //
  // Neighbors keep the parent hit's score so they cluster together
  // in the final sort, then a per-video chronological sort below
  // makes the LLM read each video's segments in temporal order.
  // Doc-source hits already chunk by section so expansion is less
  // useful there — skip.
  const NEIGHBOR_WINDOW = 2;
  const cappedKeys = new Set(capped.map(speakerHitKey));
  const expanded: SemanticSearchResult[] = [...capped];
  const neighborStmt = getDb().prepare(`
    SELECT video_id, channel_id, segment_index, start_seconds, end_seconds, speaker, text
    FROM transcript_segments_fts
    WHERE video_id = ? AND channel_id = ?
      AND segment_index BETWEEN ? AND ?
      AND segment_index <> ?
    ORDER BY segment_index
  `);
  for (const hit of capped) {
    if (hit.source === "doc" || !hit.video_id || !hit.channel_id) continue;
    const lo = Math.max(0, hit.segment_index - NEIGHBOR_WINDOW);
    const hi = hit.segment_index + NEIGHBOR_WINDOW;
    const rows = neighborStmt.all(
      hit.video_id, hit.channel_id, lo, hi, hit.segment_index,
    ) as Array<{
      video_id: string; channel_id: string; segment_index: number;
      start_seconds: number; end_seconds: number;
      speaker: string | null; text: string;
    }>;
    for (const r of rows) {
      const key = `vid:${r.video_id}:${r.channel_id}:${r.segment_index}`;
      if (cappedKeys.has(key)) continue;
      cappedKeys.add(key);
      // Inherit the parent's video metadata + score so neighbors
      // sort adjacent to their hit. Mark with score=0 so the
      // formatter can distinguish "primary hit" vs "context"
      // visually later if we want.
      expanded.push({
        ...hit,
        segment_index: r.segment_index,
        start_seconds: r.start_seconds,
        end_seconds: r.end_seconds,
        speaker: r.speaker,
        text: r.text,
        score: 0,
      });
    }
  }

  // Sort the final context so each video's hits + neighbors read
  // in chronological order. Doc-source rows interleave by their
  // distance rank (preserved from the merge above) — keep them at
  // the front since the model usually wants written docs to anchor
  // the answer.
  expanded.sort((a, b) => {
    if (a.source === "doc" && b.source !== "doc") return -1;
    if (a.source !== "doc" && b.source === "doc") return 1;
    if (a.source === "doc" && b.source === "doc") return a.rank - b.rank;
    // video-source: same video → segment order; different videos →
    // rank order (best-scoring video first).
    const sameVideo = a.video_id === b.video_id && a.channel_id === b.channel_id;
    if (sameVideo) return a.segment_index - b.segment_index;
    return a.rank - b.rank;
  });

  // Resolve local "S0"/"S1" speaker labels to global speaker names
  // for everything in the final context. Without this the LLM only
  // sees the opaque local label and can't attribute quotes by name.
  // One batch query keyed on the unique (video, channel, speaker)
  // triples — much cheaper than per-row JOINs.
  const speakerKey = (videoId: string, channelId: string, local: string) =>
    `${videoId}|${channelId}|${local}`;
  const speakerNames = new Map<string, string>();
  const triples = expanded
    .filter((r) => r.source !== "doc" && r.video_id && r.channel_id && r.speaker)
    .map((r) => ({ video_id: r.video_id, channel_id: r.channel_id, local_speaker: r.speaker! }));
  if (triples.length > 0) {
    // Dedupe before the SELECT.
    const seen = new Set<string>();
    const uniqueTriples = triples.filter((t) => {
      const k = speakerKey(t.video_id, t.channel_id, t.local_speaker);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    const placeholders = uniqueTriples.map(() => "(?, ?, ?)").join(",");
    const params: any[] = [];
    for (const t of uniqueTriples) params.push(t.video_id, t.channel_id, t.local_speaker);
    const rows = getDb().prepare(`
      SELECT vsa.video_id, vsa.channel_id, vsa.local_speaker, sp.name
      FROM video_speaker_assignments vsa
      JOIN speakers sp ON sp.id = vsa.speaker_id
      WHERE (vsa.video_id, vsa.channel_id, vsa.local_speaker) IN (VALUES ${placeholders})
    `).all(...params) as { video_id: string; channel_id: string; local_speaker: string; name: string }[];
    for (const r of rows) {
      speakerNames.set(speakerKey(r.video_id, r.channel_id, r.local_speaker), r.name);
    }
  }

  const sources: ContextSource[] = expanded.map((r, idx) => ({
    sourceIndex: idx + 1,
    source: r.source ?? "video",
    videoId: r.video_id,
    channelId: r.channel_id,
    segmentIndex: r.segment_index,
    startSeconds: r.start_seconds,
    endSeconds: r.end_seconds,
    speaker: r.speaker,
    speakerName: r.speaker
      ? (speakerNames.get(speakerKey(r.video_id, r.channel_id, r.speaker)) ?? null)
      : null,
    excerpt: r.text,
    score: r.score,
    videoTitle: r.title,
    channelName: r.channel_name,
    uploadDate: r.upload_date,
    videoPath: r.video_path,
    mdPath: r.md_path,
    status: r.status,
    isLive: r.is_live,
    duration: null,         // not in semantic-search result; reload fetches it
    wordCount: r.word_count,
    documentId: r.document_id,
    docRootId: r.doc_root_id,
    docRelPath: r.doc_rel_path,
    docTitle: r.doc_title,
    docHeadingPath: r.doc_heading_path,
    docStartChar: r.doc_start_char,
    docEndChar: r.doc_end_char,
  }));

  const topScore = sources[0]?.score ?? 0;
  const weakRetrieval = sources.length === 0 || topScore < RELEVANT_SCORE_FLOOR;

  yield { type: "context", sources, weakRetrieval };

  if (sources.length === 0) {
    yield { type: "delta", text: "The archive doesn't have anything that matches this question. Try rephrasing or check whether the topic has been transcribed yet." };
    yield { type: "done" };
    return;
  }

  const sourceBlock = formatSourceBlock(sources);
  const userPrompt = `Sources:\n\n${sourceBlock}\n\nQuestion: ${args.question}`;

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    // Last N exchanges of history get included verbatim. v1 stuffs them in
    // as raw context — good enough for "tell me more about that" follow-ups
    // where the new question is interpretable on its own. Query rewriting
    // (have the model rewrite a vague follow-up into a standalone question
    // before retrieval) is a v2 upgrade.
    ...(args.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: "user" as const, content: userPrompt },
  ];

  try {
    for await (const chunk of chatStream({
      messages,
      model: args.chatModel,
      signal: args.signal,
    })) {
      yield { type: "delta", text: chunk };
    }
    yield { type: "done" };
  } catch (err) {
    yield { type: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
