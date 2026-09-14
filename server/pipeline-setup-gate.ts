import type { RequestHandler } from "express";
import type { PipelineSetupStatus } from "./pipeline-readiness";

export function requiresPipelineSetup(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  return ["/api/pipeline/start", "/api/pipeline/check-now", "/api/pipeline/process", "/api/pipeline/retranscribe", "/api/pipeline/retry", "/api/pipeline/transcribe-file", "/api/videos/download"].includes(pathname)
    || /^\/api\/pipeline\/channels\/[^/]+\/archive$/.test(pathname)
    || /^\/api\/pipeline\/archive\/[^/]+$/.test(pathname)
    || /^\/api\/voice-notes\/(start|[^/]+\/(chunk|finalize))$/.test(pathname)
    || /^\/api\/videos\/library\/[^/]+\/[^/]+\/(retranscribe|retry)$/.test(pathname);
}

export function pipelineSetupGate(getStatus: () => PipelineSetupStatus): RequestHandler {
  return (req, res, next) => {
    if (!requiresPipelineSetup(req.method, req.path)) return next();
    const setup = getStatus();
    if (setup.ready) return next();
    res.status(409).json({ error: "Complete Pipeline setup before downloading or transcribing.", code: "PIPELINE_SETUP_REQUIRED", setupUrl: "/pipeline/setup", setup });
  };
}
