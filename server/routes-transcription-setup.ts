import type { Express, Request, Response } from "express";
import { setConfigValues } from "./db";
import {
  detectPython,
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
export function registerTranscriptionSetupRoutes(app: Express): void {
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
      setConfigValues({
        "transcription.engine": engine,
        "transcription.venvPath": venvDir(),
      });
      send({ phase: "saved", line: `Saved engine=${engine}, venvPath=${venvDir()}` });
      send({ phase: "complete", ok: true, pythonPath: result.pythonPath, engine });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      send({ phase: "complete", ok: false, error: msg });
    } finally {
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
    setConfigValues({
      "transcription.engine": engine,
      ...(venvPath ? { "transcription.venvPath": venvPath } : {}),
    });
    res.json({ ok: true });
  });

  app.post("/api/transcription/uninstall", (_req: Request, res: Response) => {
    uninstallEngine();
    setConfigValues({
      "transcription.engine": "",
      "transcription.venvPath": "",
    });
    res.json({ ok: true });
  });
}
