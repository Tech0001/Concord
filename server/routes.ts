import type { Express } from "express";
import { createServer, type Server } from "http";
import { getPipeline } from "./pipeline";
import { registerChatRoutes } from "./routes-chat";
import { registerDownloadRoutes } from "./routes-downloads";
import { registerLibraryRoutes } from "./routes-library";
import { registerLlmRoutes } from "./routes-llm";
import { registerNotesRoutes } from "./routes-notes";
import { registerPipelineRoutes } from "./routes-pipeline";
import { registerSpeakerRoutes } from "./routes-speakers";
import { registerSystemRoutes } from "./routes-system";
import { registerTranscriptionSetupRoutes } from "./routes-transcription-setup";
import { registerVoiceNoteRoutes } from "./routes-voice-notes";
import { registerYouTubeRoutes } from "./routes-youtube";
import { registerDocsRoutes } from "./routes-docs";
import { indexDocs } from "./docs-index";

/**
 * Top-level HTTP wire-up. Every actual endpoint lives in a sibling
 * routes-*.ts module; this file's job is just to instantiate the
 * Pipeline singleton, register each domain in turn, and hook
 * shutdown cleanup. Adding an endpoint = pick the right sibling
 * (or create a new one) — don't accumulate them here.
 */
export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);
  const pipeline = getPipeline();

  // ---- One-off video downloads ----
  // /api/videos/info, /api/videos/download, the SSE progress stream,
  // and the file-serve endpoint — registered in routes-downloads.ts.
  // Owns the temp/ working directory and the periodic cleanup; returns
  // a shutdown hook called when the HTTP server closes.
  const downloads = registerDownloadRoutes(app, pipeline);

  // ---- System / status / config / dialog ----
  // /api/pipeline/status, /api/status, /api/pipeline/config (get+post),
  // /api/pipeline/ytdlp-health, /api/system/*, /api/dialog/pick-folder
  // — all registered in routes-system.ts.
  registerSystemRoutes(app, pipeline, httpServer);

  // ---- LLM (config, status, embeddings reindex, summaries, semantic
  // search, models proxy) ---- registered in routes-llm.ts.
  registerLlmRoutes(app, pipeline);

  // ---- AI chat (RAG over the archive) ----
  // /api/chat/* + /api/llm/ask registered in routes-chat.ts.
  registerChatRoutes(app, pipeline);

  // ---- Speakers ----
  // /api/speakers/* registered in routes-speakers.ts.
  registerSpeakerRoutes(app);

  // ---- Notes (transcript_clips) + tags + links + graph ----
  // /api/clips/* registered in routes-notes.ts.
  registerNotesRoutes(app, pipeline);

  // ---- Transcription setup wizard ----
  // /api/transcription/* — first-launch venv install, engine select, etc.
  registerTranscriptionSetupRoutes(app);

  // ---- Library / transcripts / search / stream / orphans / export ----
  // /api/transcripts/search*, /api/videos/library/* (transcript, rename,
  // relink, forget, trash, stream, export-segment, speakers, notes,
  // orphans), and /api/pipeline/queue listings — registered in
  // routes-library.ts.
  registerLibraryRoutes(app, pipeline);

  // ---- Voice notes (mic dictation) ----
  // /api/voice-notes/{start, :id/chunk, :id/finalize, :id/cancel} —
  // start a recording, push raw PCM chunks, finalize for offline
  // FluidAudio processing. Registered in routes-voice-notes.ts.
  registerVoiceNoteRoutes(app, pipeline);

  // ---- YouTube Discover (search + watchers + inbox) ----
  // /api/youtube/{search, watchers, inbox} — manual search via the
  // YouTube Data API v3 plus saved-search watchers that poll on a
  // configurable cadence. Registered in routes-youtube.ts.
  registerYouTubeRoutes(app);

  // ---- Markdown docs ----
  // /api/docs/{config, tree, file, by-path, reindex, :id/{starred,
  // category}} — browser + star/category controls, plus the indexer
  // that keeps the documents table in sync with the filesystem.
  registerDocsRoutes(app);
  // Initial index runs once at startup so the first /api/docs/tree
  // request returns rich rows (star/category) instead of bare
  // filesystem nodes. Wrapped in try/catch — a missing root folder
  // shouldn't crash the server boot.
  try {
    const res = indexDocs();
    if (res.total > 0) {
      console.log(`[docs] Indexed ${res.total} files (${res.inserted} new, ${res.updated} updated, ${res.removed} removed, ${res.ms}ms)`);
    }
  } catch (err) {
    console.warn("[docs] Initial index failed:", err instanceof Error ? err.message : err);
  }

  // ---- Pipeline lifecycle + channel management ----
  // /api/pipeline/{start,stop,check-now,process,events,transcripts,
  // channels,retranscribe,transcribe-file,archive} — registered in
  // routes-pipeline.ts.
  registerPipelineRoutes(app, pipeline);

  // Set up cleanup when the server shuts down. The downloads module
  // owns its own temp-cleanup interval; call its shutdown hook so the
  // interval gets cleared along with the pipeline.
  httpServer.on("close", () => {
    console.log("Server shutting down, stopping background timers");
    downloads.shutdown();
    pipeline.stop();
  });

  return httpServer;
}
