import type { Express, Request, Response } from "express";
import type { Pipeline } from "./pipeline";
import { backgroundJobs, type BackgroundJob, type BackgroundJobType } from "./background-jobs";

const JOB_TYPES = new Set<BackgroundJobType>([
  "segment_embeddings",
  "doc_embeddings",
  "note_embeddings",
  "video_summaries",
  "thumbnail_backfill",
  "media_fingerprints",
  "derived_index_cleanup",
]);

function publicJob(job: BackgroundJob) {
  const { items: _items, ...payload } = job.payload;
  return { ...job, payload };
}

export function registerBackgroundJobRoutes(app: Express, pipeline: Pipeline): void {
  app.get("/api/background-jobs", (req, res) => {
    const limit = Number(req.query.limit || 100);
    res.setHeader("Cache-Control", "no-store");
    res.json({ jobs: backgroundJobs.list(Number.isFinite(limit) ? limit : 100).map(publicJob) });
  });

  app.post("/api/background-jobs", (req, res) => {
    const type = String(req.body?.type || "") as BackgroundJobType;
    if (!JOB_TYPES.has(type)) {
      return res.status(400).json({ error: `type must be one of ${Array.from(JOB_TYPES).join(", ")}` });
    }
    const llm = pipeline.getConfig().llm;
    const localJob = type === "thumbnail_backfill" || type === "media_fingerprints" || type === "derived_index_cleanup";
    const configured = type === "video_summaries" ? llm.chatModel : localJob ? "local" : llm.embeddingModel;
    const model = String(req.body?.model || configured || "").trim();
    if (!model) {
      return res.status(400).json({ error: type === "video_summaries" ? "No chat model configured" : "No embedding model configured" });
    }
    const job = backgroundJobs.enqueue(type, {
      model,
      overwrite: req.body?.overwrite === true,
      wipe: req.body?.wipe === true,
    });
    res.status(202).json({ job: publicJob(job) });
  });

  app.post("/api/background-jobs/:id/cancel", (req: Request<{ id: string }>, res: Response) => {
    const job = backgroundJobs.cancel(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.json({ job: publicJob(job) });
  });

  app.post("/api/background-jobs/:id/retry", (req: Request<{ id: string }>, res: Response) => {
    const job = backgroundJobs.retry(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found or not retryable" });
    res.json({ job: publicJob(job) });
  });

  app.post("/api/background-jobs/:id/retry-failures", (req: Request<{ id: string }>, res: Response) => {
    const job = backgroundJobs.retryFailures(req.params.id);
    if (!job) return res.status(404).json({ error: "Job has no retryable failed items" });
    res.status(202).json({ job: publicJob(job) });
  });

  app.get("/api/background-jobs/:id/diagnostic", (req: Request<{ id: string }>, res: Response) => {
    const job = backgroundJobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=concord-job-${job.id}.json`);
    res.send(JSON.stringify({ exportedAt: new Date().toISOString(), app: "Concord", job }, null, 2));
  });
}
