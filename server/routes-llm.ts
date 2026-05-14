import type { Express, Request, Response } from "express";
import {
  listModels as llmListModels,
  probeStatus as llmProbeStatus,
  validateChatModel,
  validateEmbeddingModel,
  LlmConfigError,
  LlmHttpError,
  LlmUnreachableError,
} from "./llm";
import { searchSemantic } from "./semantic-search";
import { embedSegmentsForVideo } from "./embed-segments";
import { summarizeVideo } from "./summarize-video";
import {
  getEmbeddingStats,
  clearAllEmbeddings,
  setVideoAiSummary,
  getCoveredVideoKeysForModel,
  getQueueList,
} from "./db";
import type { Pipeline } from "./pipeline";

/**
 * /api/llm/* and the semantic-search endpoint — LLM config CRUD, model
 * probe, embedding reindex (SSE), AI summary regen (single + bulk
 * SSE), semantic search, model list proxy.
 *
 * The chat / RAG endpoints are still registered through routes-chat.ts;
 * this module just covers the "talk to the LLM directly" surface.
 */
export function registerLlmRoutes(app: Express, pipeline: Pipeline): void {
  // Read current LLM config. Never returns the raw API key — only `hasApiKey`.
  app.get("/api/llm/config", (_req, res) => {
    const llm = pipeline.getConfig().llm;
    res.json({
      baseUrl: llm.baseUrl,
      chatModel: llm.chatModel,
      embeddingModel: llm.embeddingModel,
      hasApiKey: Boolean(llm.apiKey),
    });
  });

  // Update LLM config. Body may contain any subset of
  // { baseUrl, apiKey, chatModel, embeddingModel }. Sending apiKey
  // overwrites the stored value (including with "" to clear). Omit
  // apiKey to leave it.
  app.post("/api/llm/config", (req, res) => {
    try {
      const updates: Partial<{ baseUrl: string; apiKey: string; chatModel: string; embeddingModel: string }> = {};
      const body = req.body || {};
      if (typeof body.baseUrl === "string") updates.baseUrl = body.baseUrl.trim();
      if (typeof body.apiKey === "string") updates.apiKey = body.apiKey;
      if (typeof body.chatModel === "string") updates.chatModel = body.chatModel.trim();
      if (typeof body.embeddingModel === "string") updates.embeddingModel = body.embeddingModel.trim();
      pipeline.updateConfig({ llm: { ...pipeline.getConfig().llm, ...updates } });
      const llm = pipeline.getConfig().llm;
      res.json({
        success: true,
        config: {
          baseUrl: llm.baseUrl,
          chatModel: llm.chatModel,
          embeddingModel: llm.embeddingModel,
          hasApiKey: Boolean(llm.apiKey),
        },
      });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid config" });
    }
  });

  // Quick reachability + identity probe. Always 200; body says reachable=false on error.
  app.get("/api/llm/status", async (_req, res) => {
    res.json(await llmProbeStatus());
  });

  // Pre-save sanity check: prove each candidate model is the right *kind*
  // (chat vs. embedding). The LLM returns clear 400s when the slots are
  // swapped (e.g. an embedding model in the chat slot), but those errors
  // would otherwise only show up later when a summary or embed job fails
  // in the background. Settings → Save calls this before persisting and
  // surfaces a toast on kind-mismatch so the user can fix it immediately.
  app.post("/api/llm/validate-models", async (req, res) => {
    const body = req.body || {};
    const chatModel = typeof body.chatModel === "string" ? body.chatModel.trim() : "";
    const embeddingModel = typeof body.embeddingModel === "string" ? body.embeddingModel.trim() : "";
    const [chat, embedding] = await Promise.all([
      chatModel ? validateChatModel(chatModel) : Promise.resolve({ ok: true as const }),
      embeddingModel ? validateEmbeddingModel(embeddingModel) : Promise.resolve({ ok: true as const }),
    ]);
    res.json({ chat, embedding });
  });

  // ---- Semantic search & embedding management ----

  app.get("/api/llm/embeddings/stats", (_req, res) => {
    res.json(getEmbeddingStats());
  });

  // Reindex everything. Walks every transcribed video and re-embeds.
  // Slow for big libraries (hundreds of API calls of 50 segments each),
  // so it streams progress over SSE rather than holding a long HTTP
  // request.
  app.post("/api/llm/embeddings/reindex", async (req, res) => {
    const cfg = pipeline.getConfig().llm;
    const model = (req.body?.model as string | undefined) || cfg.embeddingModel;
    if (!model) {
      return res.status(400).json({ error: "No embedding model configured (set on AI page first)" });
    }

    const wipe = req.body?.wipe === true;
    if (wipe) clearAllEmbeddings(model);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // Fire a "preparing" event immediately so the UI knows the request
    // is alive while we compute the work list. Without this, the user
    // sees nothing happen for a few seconds and assumes the connection
    // died.
    sse("preparing", { model });

    // Default behavior: catch-up only — skip videos that already have
    // embeddings for this model. Wipe forces a full re-embed (used when
    // changing models or rebuilding from scratch). Single SQL query for
    // the covered set instead of N round-trips through hasVideoEmbeddings.
    const allVideos = getQueueList({ status: "complete", limit: 100000 }).rows;
    let videos = allVideos;
    if (!wipe) {
      const covered = new Set(
        getCoveredVideoKeysForModel(model).map(({ videoId, channelId }) => `${videoId}|${channelId}`),
      );
      videos = allVideos.filter((v) => !covered.has(`${v.video_id}|${v.channel_id}`));
    }
    const alreadyCovered = allVideos.length - videos.length;

    sse("start", { total: videos.length, model, alreadyCovered });

    let done = 0;
    let totalSegments = 0;
    let skipped = 0;
    for (const v of videos) {
      try {
        const r = await embedSegmentsForVideo(v.video_id, v.channel_id, model);
        if (r.skipped) {
          skipped++;
          // Server log echo for debuggability — the SSE event also
          // carries the reason, but having it in the dev log makes
          // "why was THIS video skipped?" answerable without diffing
          // the browser.
          console.log(`[reindex] skipped ${v.video_id}: ${r.skipped}`);
        } else {
          totalSegments += r.segmentCount;
        }
        sse("video", { ...r, done: ++done, total: videos.length });
      } catch (err) {
        sse("video", {
          videoId: v.video_id, channelId: v.channel_id, model, segmentCount: 0,
          error: err instanceof Error ? err.message : String(err),
          done: ++done, total: videos.length,
        });
      }
    }

    sse("done", { total: videos.length, totalSegments, skipped, model });
    res.end();
  });

  // Regenerate the AI summary for a single video. Used by the per-video
  // "Regenerate" button in the transcript drawer. Synchronous (no SSE)
  // since it's one chat call — the UI can show a spinner.
  app.post(
    "/api/videos/library/:channelId/:videoId/ai-summary/regenerate",
    async (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
      try {
        const cfg = pipeline.getConfig().llm;
        const model = cfg.chatModel;
        if (!model) return res.status(400).json({ error: "No chat model configured (set on AI page first)" });

        // Clear so summarizeVideo's "already populated by this model"
        // guard doesn't short-circuit the regen.
        setVideoAiSummary(req.params.videoId, req.params.channelId, null, null);

        const result = await summarizeVideo(req.params.videoId, req.params.channelId, model);
        if (result.skipped) return res.status(400).json({ error: result.skipped, model: result.model });
        res.json({
          success: true,
          model: result.model,
          charsIn: result.charsIn,
          charsOut: result.charsOut,
        });
      } catch (err) {
        if (err instanceof LlmConfigError) return res.status(400).json({ error: err.message });
        if (err instanceof LlmUnreachableError) return res.status(503).json({ error: err.message });
        res.status(500).json({ error: err instanceof Error ? err.message : "Unknown" });
      }
    },
  );

  // Bulk-generate AI summaries for every transcribed video. SSE-streamed
  // since iterating + calling chat() per video is slow (multi-second per
  // call). By default, skips videos whose notes are already populated;
  // pass `overwrite: true` to regenerate everything (used when the model
  // changes or the prompt is tweaked).
  app.post("/api/llm/summaries/regenerate", async (req, res) => {
    const cfg = pipeline.getConfig().llm;
    const model = (req.body?.model as string | undefined) || cfg.chatModel;
    if (!model) {
      return res.status(400).json({ error: "No chat model configured (set on AI page first)" });
    }

    const overwrite = req.body?.overwrite === true;
    const videos = getQueueList({ status: "complete", limit: 100000 }).rows;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
    sse("start", { total: videos.length, model, overwrite });

    let done = 0;
    let written = 0;
    let skipped = 0;
    for (const v of videos) {
      try {
        if (overwrite) {
          // Clear so summarizeVideo doesn't short-circuit on the
          // "already populated by this model" idempotency guard.
          setVideoAiSummary(v.video_id, v.channel_id, null, null);
        }
        const r = await summarizeVideo(v.video_id, v.channel_id, model);
        if (r.skipped) skipped++;
        else written++;
        sse("video", { ...r, done: ++done, total: videos.length });
      } catch (err) {
        sse("video", {
          videoId: v.video_id, channelId: v.channel_id, model,
          charsIn: 0, charsOut: 0,
          error: err instanceof Error ? err.message : String(err),
          done: ++done, total: videos.length,
        });
      }
    }

    sse("done", { total: videos.length, written, skipped, model });
    res.end();
  });

  // Semantic search — embeds the query, cosines vs all stored vectors.
  app.post("/api/transcripts/search-semantic", async (req, res) => {
    try {
      const query = String(req.body?.query || "").trim();
      if (!query) return res.status(400).json({ error: "query required" });

      const cfg = pipeline.getConfig().llm;
      const model = cfg.embeddingModel;
      if (!model) {
        return res.status(400).json({ error: "No embedding model configured (set on AI page first)" });
      }

      const out = await searchSemantic({
        query,
        model,
        limit: req.body?.limit,
        minScore: typeof req.body?.minScore === "number" ? req.body.minScore : undefined,
        filters: req.body?.filters,
      });
      res.json(out);
    } catch (err) {
      if (err instanceof LlmConfigError) return res.status(400).json({ error: err.message });
      if (err instanceof LlmUnreachableError) return res.status(503).json({ error: err.message });
      if (err instanceof LlmHttpError) return res.status(err.status).json({ error: err.message, body: err.body });
      res.status(500).json({ error: err instanceof Error ? err.message : "Unknown" });
    }
  });

  // Proxy to provider's /v1/models so the AI page can populate model dropdowns.
  app.get("/api/llm/models", async (_req, res) => {
    try {
      const models = await llmListModels();
      res.json({ models });
    } catch (error) {
      if (error instanceof LlmConfigError) {
        return res.status(400).json({ error: error.message, kind: "config" });
      }
      if (error instanceof LlmUnreachableError) {
        return res.status(503).json({ error: error.message, kind: "unreachable" });
      }
      if (error instanceof LlmHttpError) {
        return res.status(error.status).json({ error: error.message, kind: "http", body: error.body });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : "Unknown" });
    }
  });
}
