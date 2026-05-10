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
      maxTokens: 4000,
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

  summary = summary.trim();
  if (!summary) {
    return { ...base, charsIn, skipped: "model returned empty summary" };
  }

  setVideoAiSummary(videoId, channelId, summary, chatModel);
  return { ...base, charsIn, charsOut: summary.length };
}
