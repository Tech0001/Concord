import type { Express, Request, Response } from "express";
import { nanoid } from "nanoid";
import {
  getSpeakersWithStats, getSpeakerById, createSpeaker, updateSpeaker, deleteSpeaker, mergeSpeakers,
  getUnidentifiedAssignments, getSpeakerAppearances, assignVideoSpeakerToGlobal,
  backfillVideoSpeakerMetadata, backfillAllZeroAirtimeAssignments,
  autoMatchUnidentifiedAgainstSpeaker, autoMatchAllUnidentified,
  getOrCreateNoiseSpeaker, pruneAllOrphanedAssignments,
} from "./db";

/**
 * All /api/speakers/* routes — global speaker CRUD, per-speaker rescan,
 * mark-as-noise, merge, manual assignment of video-locals to global
 * speakers, bulk maintenance (prune orphans, backfill airtimes). Pure
 * domain endpoints; no pipeline dependency.
 */
export function registerSpeakerRoutes(app: Express): void {
  app.get("/api/speakers", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ speakers: getSpeakersWithStats() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // Per-speaker rescan — used by the "Find more matches" button after
  // additional labels update the centroid (centroid moves → new
  // matches possible).
  app.post("/api/speakers/:id/find-matches", (req: Request<{ id: string }>, res) => {
    try {
      res.json({ matched: autoMatchUnidentifiedAgainstSpeaker(req.params.id) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // Bulk rescan — sweeps every unidentified against all known speakers,
  // takes the closest within threshold. Used by "Rescan all" on Speakers.
  app.post("/api/speakers/find-all-matches", (_req, res) => {
    try {
      res.json({ matched: autoMatchAllUnidentified() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // Sweep all videos for orphan video_speaker_assignments rows whose
  // local_speaker no longer appears in the current transcript file.
  // Caused by re-transcribes that produced fewer/different local
  // speakers than the prior run — DB rows persisted but had no chip
  // to render. Cheap (one transcript-parse per video).
  app.post("/api/speakers/prune-orphans", (_req, res) => {
    try {
      res.json(pruneAllOrphanedAssignments());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  // One-shot fix-up: scans every video_speaker_assignments row with
  // airtime_seconds = 0 (the stub-row case from labeling on pre-Phase-1
  // transcripts) and recomputes airtime + sample timestamps from each
  // transcript file. Idempotent — calling twice does no extra work the
  // second time.
  app.post("/api/speakers/backfill-stats", (_req, res) => {
    try {
      res.json(backfillAllZeroAirtimeAssignments());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.get("/api/speakers/unidentified", (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
      res.json({ assignments: getUnidentifiedAssignments(limit) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.get("/api/speakers/:id", (req: Request<{ id: string }>, res) => {
    const s = getSpeakerById(req.params.id);
    if (!s) return res.status(404).json({ error: "Speaker not found" });
    res.json({ speaker: s, appearances: getSpeakerAppearances(req.params.id) });
  });

  app.post("/api/speakers", (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "name required" });
      const displayColor = req.body?.displayColor ?? null;
      const notes = req.body?.notes ?? null;
      const id = nanoid();
      const speaker = createSpeaker({ id, name, displayColor, notes });
      res.json({ speaker });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.patch("/api/speakers/:id", (req: Request<{ id: string }>, res) => {
    const fields: { name?: string; displayColor?: string | null; notes?: string | null; isNoise?: boolean } = {};
    if (typeof req.body?.name === "string") fields.name = req.body.name.trim();
    if (req.body?.displayColor !== undefined) fields.displayColor = req.body.displayColor;
    if (req.body?.notes !== undefined) fields.notes = req.body.notes;
    if (typeof req.body?.isNoise === "boolean") fields.isNoise = req.body.isNoise;
    const updated = updateSpeaker(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: "Speaker not found" });
    res.json({ speaker: updated });
  });

  // Merge a duplicate speaker into another. Reassigns every
  // video_speaker_assignments row from source → target, folds the source
  // centroid into the target via count-weighted average, then deletes the
  // source. Atomic.
  app.post("/api/speakers/:id/merge", (req: Request<{ id: string }>, res) => {
    try {
      const targetId = String(req.body?.targetId || "");
      if (!targetId) return res.status(400).json({ error: "targetId required" });
      const result = mergeSpeakers(req.params.id, targetId);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Merge failed" });
    }
  });

  // "Mark as noise" — assigns one or more video-locals in a video to the
  // singleton noise speaker (creating it on first use). Doesn't take a
  // name/color from the user; the noise speaker is a fixed grey "(noise)"
  // bucket. Auto-rescan still fires so similar noise auto-folds in.
  app.post("/api/speakers/mark-noise", (req, res) => {
    try {
      const videoId = String(req.body?.videoId || "");
      const channelId = String(req.body?.channelId || "");
      const localSpeaker = String(req.body?.localSpeaker || "");
      if (!videoId || !channelId || !localSpeaker) {
        return res.status(400).json({ error: "videoId, channelId, localSpeaker required" });
      }
      const additional: string[] = Array.isArray(req.body?.additionalLocalSpeakers)
        ? req.body.additionalLocalSpeakers.filter((x: unknown) => typeof x === "string" && x !== localSpeaker)
        : [];

      const noise = getOrCreateNoiseSpeaker(nanoid());
      assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker, speakerId: noise.id });
      backfillVideoSpeakerMetadata(videoId, channelId, localSpeaker);
      for (const al of additional) {
        assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker: al, speakerId: noise.id });
        backfillVideoSpeakerMetadata(videoId, channelId, al);
      }
      const autoMatched = autoMatchUnidentifiedAgainstSpeaker(noise.id);
      res.json({ success: true, speakerId: noise.id, autoMatched, additionalAssigned: additional.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });

  app.delete("/api/speakers/:id", (req: Request<{ id: string }>, res) => {
    const ok = deleteSpeaker(req.params.id);
    res.json({ success: ok });
  });

  // Manually assign (or re-assign) a video-local speaker to a global one.
  // Pass speakerId to link, or null to unlink. If `newName` is provided
  // and `speakerId` is omitted, creates a new speaker first then assigns.
  app.post("/api/speakers/assign", (req, res) => {
    try {
      const videoId = String(req.body?.videoId || "");
      const channelId = String(req.body?.channelId || "");
      const localSpeaker = String(req.body?.localSpeaker || "");
      if (!videoId || !channelId || !localSpeaker) {
        return res.status(400).json({ error: "videoId, channelId, localSpeaker required" });
      }
      let speakerId: string | null;
      let createdSpeaker = null;
      if (typeof req.body?.newName === "string" && req.body.newName.trim()) {
        const id = nanoid();
        createdSpeaker = createSpeaker({
          id,
          name: req.body.newName.trim(),
          displayColor: req.body.displayColor ?? null,
        });
        speakerId = id;
      } else if (req.body?.speakerId === null) {
        speakerId = null;
      } else if (typeof req.body?.speakerId === "string") {
        speakerId = req.body.speakerId;
      } else {
        return res.status(400).json({ error: "Provide speakerId, newName, or speakerId=null" });
      }
      // Multi-select: also label these other local labels in the same
      // video as the same speaker. Handles the over-segmentation case
      // where one person ended up split into S0/S1/.../Sn chips.
      const additional: string[] = Array.isArray(req.body?.additionalLocalSpeakers)
        ? req.body.additionalLocalSpeakers.filter((x: unknown) => typeof x === "string" && x !== localSpeaker)
        : [];

      assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker, speakerId });
      backfillVideoSpeakerMetadata(videoId, channelId, localSpeaker);
      for (const al of additional) {
        assignVideoSpeakerToGlobal({ videoId, channelId, localSpeaker: al, speakerId });
        backfillVideoSpeakerMetadata(videoId, channelId, al);
      }

      // Auto-rescan whenever an assignment lands a video-local on a
      // global speaker — both new speakers AND re-assignments to existing
      // ones. The latter case matters because the assignVideoSpeakerToGlobal
      // call updates the speaker's centroid (count-weighted average from
      // this new sample), so other unidentified videos might NOW match
      // even though they didn't before. Only operates on rows that are
      // currently UNIDENTIFIED — already-labeled assignments aren't
      // touched, so prior user decisions are preserved.
      let autoMatched = 0;
      if (speakerId !== null) {
        autoMatched = autoMatchUnidentifiedAgainstSpeaker(speakerId);
      }
      res.json({ success: true, speakerId, createdSpeaker, autoMatched, additionalAssigned: additional.length });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
    }
  });
}
