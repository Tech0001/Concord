import { searchSemantic, type SemanticSearchResult } from "./semantic-search";
import { chat, chatStream } from "./llm";
import { searchTranscriptSegments, type ChatMessage as PersistedChatMessage } from "./db";

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
    const speaker = s.speaker ? ` · Speaker: ${s.speaker}` : "";
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
    const search = await searchSemantic({
      query: retrievalQuery,
      model: args.embeddingModel || "",
      limit: topK * 2,
      minScore: 0.3,
      filters: {
        ...(args.channelIds && args.channelIds.length === 1 ? { channelId: args.channelIds[0] } : {}),
        ...(args.category ? { category: args.category } : {}),
      },
    });
    semanticCandidates = search.results;
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
  let ftsRows: SemanticSearchResult[] = [];
  try {
    ftsRows = ftsCandidates(retrievalQuery, args.channelIds, topK * 2, args.category);
  } catch {
    ftsRows = [];
  }

  const fused = ftsRows.length > 0
    ? rankFuse(semanticCandidates, ftsRows, topK * 2)
    : semanticCandidates;

  const capped = applyPerVideoCap(fused, perVideoCap).slice(0, topK);

  const sources: ContextSource[] = capped.map((r, idx) => ({
    sourceIndex: idx + 1,
    source: r.source ?? "video",
    videoId: r.video_id,
    channelId: r.channel_id,
    segmentIndex: r.segment_index,
    startSeconds: r.start_seconds,
    endSeconds: r.end_seconds,
    speaker: r.speaker,
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
