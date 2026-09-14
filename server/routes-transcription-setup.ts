import type { Express, Request, Response } from "express";
import { setConfigValues } from "./db";
import type { Pipeline } from "./pipeline";
import { transcriptionDefaults } from "./transcription-config";
import { clearRuntimeChecks, setRuntimeInstalling } from "./pipeline-readiness";
import {
  detectPython,
  detectGpu,
  getSetupStatus,
  installEngine,
  uninstallEngine,
  venvDir,
  type EngineId,
  type InstallProgress,
} from "./transcription-setup";

/**
 * Endpoints for the first-launch transcription wizard and the Settings →
 * Transcription page.
 *
 *   GET  /api/transcription/status      Snapshot for rendering the wizard
 *   POST /api/transcription/install     SSE stream — runs venv + pip install
 *   POST /api/transcription/select      Persist a chosen engine to config
 *   POST /api/transcription/uninstall   Wipe the venv (used by Reinstall)
 */
export function registerTranscriptionSetupRoutes(app: Express, pipeline: Pipeline): void {
  let installing = false;
  const saveEngine = (engine: EngineId, directory: string) => {
    const defaults = transcriptionDefaults(engine, detectGpu().present, directory);
    setConfigValues({
      ...Object.fromEntries(Object.entries(defaults).map(([key, value]) => [`transcription.${key}`, value])),
      "processing.diarizationEnabled": engine === "parakeet",
    });
    clearRuntimeChecks();
    pipeline.reloadConfig();
  };
  app.get("/api/transcription/status", (_req: Request, res: Response) => {
    res.json(getSetupStatus());
  });

  // SSE stream — pip install can take 5–10 minutes; SSE is the simplest way
  // to push line-by-line progress without a websocket. Body uses POST with
  // a JSON body so we can carry the engine choice; the response is text/event-stream.
  app.post("/api/transcription/install", async (req: Request, res: Response) => {
    const engine = req.body?.engine as EngineId | undefined;
    if (engine !== "parakeet" && engine !== "whisper") {
      return res.status(400).json({ error: "engine must be 'parakeet' or 'whisper'" });
    }

    if (installing) return res.status(409).json({ error: "Transcription installation is already running." });
    if (pipeline.getState().jobs.some(job => ["queued", "downloading", "extracting_audio", "transcribing"].includes(job.status))) {
      return res.status(409).json({ error: "Wait for the current processing jobs to finish before changing the transcription installation." });
    }
    installing = true;
    setRuntimeInstalling(true);
    pipeline.stop();
    setConfigValues({ "pipeline.setupCompleted": false });
    clearRuntimeChecks();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Disable proxy/middleware buffering — every line should hit the wire
    // immediately so the wizard's log feels live.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const send = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const onProgress = (event: InstallProgress) => send(event);

    try {
      const python = detectPython();
      send({ phase: "status", line: `python: ${python.path} (${python.version || "?"})` });
      const result = await installEngine(engine, python, onProgress);
      // Persist the new engine + venv path to config so transcribe.ts can
      // pick it up without a restart.
      saveEngine(engine, venvDir());
      send({ phase: "saved", line: `Saved engine=${engine}, venvPath=${venvDir()}` });
      send({ phase: "complete", ok: true, pythonPath: result.pythonPath, engine });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ phase: "complete", ok: false, error: msg });
    } finally {
      installing = false;
      setRuntimeInstalling(false);
      res.end();
    }
  });

  // For "I already have a venv" / advanced users — point at an existing
  // python without running pip install. Validates the binary exists.
  app.post("/api/transcription/select", (req: Request, res: Response) => {
    const engine = req.body?.engine as EngineId | undefined;
    const venvPath = typeof req.body?.venvPath === "string" ? req.body.venvPath : null;
    if (engine !== "parakeet" && engine !== "whisper") {
      return res.status(400).json({ error: "engine must be 'parakeet' or 'whisper'" });
    }
    if (installing) return res.status(409).json({ error: "Wait for the transcription installation to finish." });
    const status = getSetupStatus();
    if (!venvPath && (!status.venv.exists || status.venv.engine !== engine)) {
      return res.status(400).json({ error: "Install this engine first." });
    }
    saveEngine(engine, venvPath || venvDir());
    res.json({ ok: true });
  });

  app.post("/api/transcription/uninstall", (_req: Request, res: Response) => {
    if (installing) return res.status(409).json({ error: "Wait for the transcription installation to finish." });
    if (pipeline.getState().jobs.some(job => ["queued", "downloading", "extracting_audio", "transcribing"].includes(job.status))) {
      return res.status(409).json({ error: "Wait for processing jobs to finish before removing their transcription engine." });
    }
    pipeline.stop();
    uninstallEngine();
    setConfigValues({
      "transcription.engine": "",
      "transcription.venvPath": "",
      "pipeline.setupCompleted": false,
    });
    clearRuntimeChecks();
    pipeline.reloadConfig();
    res.json({ ok: true });
  });
}
