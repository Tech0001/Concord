import type { Express, Request, Response } from "express";
import express from "express";
import {
  startSession,
  getSession,
  appendChunk,
  transcribeChunk,
  appendLiveTranscript,
  finalizeSession,
  cancelSession,
} from "./voice-notes";
import type { Pipeline } from "./pipeline";

// Raw-body middleware just for the chunk endpoint. The default app.use
// parses JSON / urlencoded which would buffer the upload as text and
// mangle binary bytes. Cap at 30 MB per chunk — way more than any
// realistic chunk size (10s of 16 kHz mono int16 = 320 KB) so even very
// large pasted segments don't get rejected.
const rawPcmMiddleware = express.raw({
  type: "application/octet-stream",
  limit: "30mb",
});

/**
 * /api/voice-notes/* — start a recording, push PCM chunks, finalize for
 * pipeline processing, or cancel. See server/voice-notes.ts for the
 * session lifecycle. The chunk endpoint returns the live-preview
 * transcript text (running concatenation) so the React side just polls
 * its response on each chunk POST instead of also opening an SSE stream.
 */
export function registerVoiceNoteRoutes(app: Express, pipeline: Pipeline): void {
  // Start a new recording session. Returns the sessionId the client
  // uses for subsequent chunk uploads + finalize.
  app.post("/api/voice-notes/start", (_req: Request, res: Response) => {
    try {
      const session = startSession();
      res.json({
        sessionId: session.id,
        startedAt: session.startedAt,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to start session" });
    }
  });

  // Append a chunk of raw 16 kHz mono int16 LE PCM. Body is the raw bytes
  // (Content-Type: application/octet-stream). Returns the running live
  // preview transcript — the client just renders it as-is. Transcription
  // is awaited so the UI sees consistent ordering; the per-chunk cost is
  // ~100 ms on Apple Silicon so the post completes in roughly real time.
  app.post(
    "/api/voice-notes/:id/chunk",
    rawPcmMiddleware,
    async (req: Request<{ id: string }>, res: Response) => {
      const session = getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: "session not found" });
      }
      const pcm = req.body as Buffer | undefined;
      if (!pcm || !Buffer.isBuffer(pcm) || pcm.length === 0) {
        return res.status(400).json({ error: "empty or non-binary body — expected raw int16le PCM" });
      }
      try {
        appendChunk(session.id, pcm);
        const chunkText = await transcribeChunk(pcm);
        const transcript = appendLiveTranscript(session.id, chunkText);
        res.json({
          transcript,
          chunkText,
          durationSeconds: session.pcmBytes / (16000 * 2), // 16kHz mono int16
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Chunk handling failed" });
      }
    },
  );

  // Stop the recording, patch the WAV header, enqueue for the offline
  // FluidAudio pass. Optional `title` in the JSON body overrides the
  // default "Voice note YYYY-MM-DD HH:MM:SS" name.
  app.post(
    "/api/voice-notes/:id/finalize",
    async (req: Request<{ id: string }>, res: Response) => {
      const session = getSession(req.params.id);
      if (!session) {
        return res.status(404).json({ error: "session not found" });
      }
      const title = typeof req.body?.title === "string" ? req.body.title : undefined;
      try {
        const result = await finalizeSession(session.id, { title });
        // Wake the pipeline so it grabs the freshly-enqueued row right
        // away instead of waiting for the next periodic scan or a
        // currently-running job to finish.
        pipeline.kickQueue();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : "Finalize failed" });
      }
    },
  );

  // Drop a session and delete its WAV without enqueueing. Used when the
  // user opens the recorder, talks for a few seconds, and hits "discard"
  // instead of "save".
  app.post(
    "/api/voice-notes/:id/cancel",
    (req: Request<{ id: string }>, res: Response) => {
      cancelSession(req.params.id);
      res.json({ ok: true });
    },
  );
}
