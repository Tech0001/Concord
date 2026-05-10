import {
  getQueueEntryByVideoId,
  getTranscriptSegmentsForVideo,
  setVideoAiSummary,
} from "./db";
import {
  chat,
  LlmConfigError,
  LlmHttpError,
  LlmUnreachableError,
} from "./llm";

export interface SummarizeResult {
  videoId: string;
  channelId: string;
  model: string;
  charsIn: number;
  charsOut: number;
  skipped?: string;
}

// Chat models have context limits — for very long transcripts (multi-hour
// audio) we cap at ~24k chars (~6k tokens at 4 chars/token avg) which fits
// comfortably in 32k-context Qwen3.6 chats with room for the system prompt
// and response. Anything longer gets truncated; we note that in the summary
// prompt so the model knows.
const MAX_CHARS = 24_000;

const SYSTEM_PROMPT = [
  "You are summarizing a video transcript for a personal research archive.",
  "Write a SHORT 2-3 sentence summary capturing the main topics or claims discussed.",
  "Use plain prose — no markdown headers, no bullet points, no preamble like \"This video discusses\".",
  "Start directly with the substance. Be specific (names, numbers, places) where the transcript is.",
].join(" ");

/**
 * Cleanup for thinking-model output. Designed around two observations:
 *
 *   1. Big thinking models (Qwen3.6-27B etc.) emit a long visible
 *      analysis section that mirrors the prompt ("Here's a thinking
 *      process: 1. **Analyze User Input:** ...") followed by the
 *      actual summary as a standalone paragraph at the end.
 *   2. Trying to recognize-and-strip the analysis is brittle (every
 *      model phrases it differently). Trying to extract the summary
 *      via tags is brittle (models forget tags).
 *
 * Strategy: take the LAST paragraph if it looks like prose (not a list,
 * substantive length). That's the model's natural "answer" paragraph.
 * If the response doesn't have that shape — single paragraph, or last
 * paragraph is itself a list/header — return the whole response. The
 * user sees verbose output rather than empty.
 *
 * Also strips `<think>...</think>` XML blocks (DeepSeek-R1 convention).
 *
 * Hard guarantee: never returns empty if `raw` was non-empty.
 */
function cleanSummary(raw: string): string {
  if (!raw) return raw;

  // 1. Strip closed `<think>...</think>` blocks (XML-tag thinking
  //    models). Unclosed tags are left alone — bare-trim fallback wins.
  let out = raw.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
  if (!out) out = raw.trim();

  // 2. If the response has paragraph structure, prefer the last
  //    substantive prose paragraph (= the actual summary the model
  //    produced after its analysis). "Substantive" = >= 50 chars and
  //    doesn't start with a list/header marker.
  const paragraphs = out.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paragraphs.length > 1) {
    const last = paragraphs[paragraphs.length - 1];
    const startsWithListOrHeader = /^(?:\d+\.\s|[*•-]\s|#|\*\*[A-Z][^*]*\*\*\s*$)/.test(last);
    if (last.length >= 50 && !startsWithListOrHeader) return last;
  }

  // 3. Fallback: return whatever we have. Verbose > empty.
  return out;
}

/**
 * Summarize one video's transcript with the configured chat model and
 * write the result to its `ai_summary` field (NOT `notes` — those are
 * for the user's own observations and are kept untouched). Best-effort
 * by design: fails open like the embed hook. Skips silently if:
 *   - No chat model configured
 *   - LLM unreachable
 *   - ai_summary already populated by the SAME model (auto-fire idempotency;
 *     pass overwrite via setVideoAiSummary(null) before calling to force regen)
 *   - Transcript not on disk
 */
export async function summarizeVideo(
  videoId: string,
  channelId: string,
  chatModel: string,
): Promise<SummarizeResult> {
  const base = { videoId, channelId, model: chatModel, charsIn: 0, charsOut: 0 };
  if (!chatModel) {
    return { ...base, skipped: "no chat model configured" };
  }

  const entry = getQueueEntryByVideoId(videoId);
  if (!entry || entry.channel_id !== channelId) {
    return { ...base, skipped: "queue entry not found" };
  }
  if (entry.ai_summary && entry.ai_summary.trim().length > 0 && entry.ai_summary_model === chatModel) {
    return { ...base, skipped: "ai_summary already populated by this model" };
  }

  const segments = getTranscriptSegmentsForVideo(videoId, channelId);
  if (segments.length === 0) {
    return { ...base, skipped: "no transcript segments" };
  }

  let text = segments.map((s) => s.text).join(" ").trim();
  if (!text) {
    return { ...base, skipped: "empty transcript text" };
  }
  const charsIn = text.length;
  let truncatedNote = "";
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS);
    truncatedNote = `\n\n[Note: transcript truncated to first ${MAX_CHARS.toLocaleString()} characters of ${charsIn.toLocaleString()}.]`;
  }

  let summary: string;
  try {
    summary = await chat({
      model: chatModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Transcript:${truncatedNote}\n\n${text}` },
      ],
      temperature: 0.4,
      // 1000 gives big thinking models (Qwen3.6-27B-Thinking etc.) room
      // to finish their analysis AND emit the actual summary at the end.
      // 280 was starving them mid-analysis. cleanSummary() pulls just
      // the final summary paragraph out for display.
      maxTokens: 1000,
    });
  } catch (err) {
    if (err instanceof LlmConfigError || err instanceof LlmUnreachableError) {
      return { ...base, charsIn, skipped: err.message };
    }
    if (err instanceof LlmHttpError && err.status === 401) {
      return { ...base, charsIn, skipped: "LLM auth failed (set API key on AI page)" };
    }
    throw err;
  }

  summary = cleanSummary(summary);
  if (!summary) {
    return { ...base, charsIn, skipped: "model returned empty summary" };
  }

  setVideoAiSummary(videoId, channelId, summary, chatModel);
  return { ...base, charsIn, charsOut: summary.length };
}
