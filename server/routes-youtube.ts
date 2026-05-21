import type { Express, Request, Response } from "express";
import {
  createWatcher,
  deleteWatcher,
  getWatcher,
  listInbox,
  listWatchers,
  pollWatcher,
  searchYouTube,
  setInboxStatus,
  updateWatcher,
} from "./youtube-discover";
import { enqueueVideo, getConfigValues, setConfigValues } from "./db";

/**
 * YouTube Discover endpoints — manual search, watcher CRUD, inbox
 * review/promote, and a manual poll trigger. The background poller
 * lives in pipeline.ts; this file is just HTTP wiring.
 */
export function registerYouTubeRoutes(app: Express): void {
  // Key management lives here (not pipeline.config) so the YouTube
  // surface stays self-contained — one card in Settings, one endpoint
  // pair to back it. Response never echoes the key value; only whether
  // one is set + a masked preview for the UI.
  app.get("/api/youtube/auth", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const key = getConfigValues()["youtube.apiKey"] || "";
    res.json({
      hasKey: key.length > 0,
      preview: key ? `${key.slice(0, 4)}…${key.slice(-4)}` : "",
    });
  });

  app.post("/api/youtube/auth", (req, res) => {
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    setConfigValues({ "youtube.apiKey": apiKey });
    res.json({ ok: true, hasKey: apiKey.length > 0 });
  });

  app.get("/api/youtube/search", async (req: Request, res: Response) => {
    const q = String(req.query.q ?? "").trim();
    if (!q) return res.status(400).json({ error: "q is required" });
    const allowedOrders = new Set(["relevance", "date", "viewCount", "rating", "title"]);
    const orderParam = String(req.query.order ?? "relevance");
    const order = (allowedOrders.has(orderParam) ? orderParam : "relevance") as
      "relevance" | "date" | "viewCount" | "rating" | "title";
    const pageToken = req.query.pageToken ? String(req.query.pageToken) : null;
    const csv = (v: unknown): string[] =>
      typeof v === "string" && v.trim()
        ? v.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
        : [];
    try {
      const page = await searchYouTube(q, {
        order,
        maxResults: Number(req.query.maxResults ?? 50),
        pageToken,
        titleMustContain: csv(req.query.titleMustContain),
        titleMustNotContain: csv(req.query.titleMustNotContain),
      });
      res.json(page);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "search failed" });
    }
  });

  app.get("/api/youtube/watchers", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const catParam = String(req.query.category || "both");
    const category = catParam === "personal" || catParam === "work" ? catParam : undefined;
    res.json({ watchers: listWatchers({ category }) });
  });

  app.post("/api/youtube/watchers", (req, res) => {
    try {
      res.json({ watcher: createWatcher(req.body) });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "create failed" });
    }
  });

  app.put("/api/youtube/watchers/:id", (req: Request<{ id: string }>, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    try {
      const watcher = updateWatcher(id, req.body);
      if (!watcher) return res.status(404).json({ error: "not found" });
      res.json({ watcher });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "update failed" });
    }
  });

  app.delete("/api/youtube/watchers/:id", (req: Request<{ id: string }>, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    res.json({ removed: deleteWatcher(id) });
  });

  // Manual poll trigger so the user can run a saved watcher without
  // waiting for the background interval — useful right after editing
  // phrase variants or channel filters.
  app.post("/api/youtube/watchers/:id/poll", async (req: Request<{ id: string }>, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "bad id" });
    const watcher = getWatcher(id);
    if (!watcher) return res.status(404).json({ error: "not found" });
    try {
      const result = await pollWatcher(watcher);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "poll failed" });
    }
  });

  app.get("/api/youtube/inbox", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const status = (req.query.status as "new" | "queued" | "dismissed" | undefined) ?? "new";
    const catParam = String(req.query.category || "both");
    const category = catParam === "personal" || catParam === "work" ? catParam : undefined;
    res.json({ entries: listInbox({ status, category }) });
  });

  app.post(
    "/api/youtube/inbox/:watcherId/:videoId/queue",
    (req: Request<{ watcherId: string; videoId: string }>, res) => {
      const watcherId = Number(req.params.watcherId);
      const { videoId } = req.params;
      const watcher = getWatcher(watcherId);
      if (!watcher) return res.status(404).json({ error: "watcher not found" });
      const entry = listInbox({ status: "new" }).find(e => e.video_id === videoId && e.watcher_id === watcherId)
        ?? listInbox({ status: "dismissed" }).find(e => e.video_id === videoId && e.watcher_id === watcherId);
      if (!entry) return res.status(404).json({ error: "inbox entry not found" });
      const enqueued = enqueueVideo({
        videoId: entry.video_id,
        channelId: entry.channel_id,
        title: entry.title,
        url: `https://www.youtube.com/watch?v=${entry.video_id}`,
        uploadDate: entry.published_at?.slice(0, 10).replace(/-/g, "") ?? null,
        category: watcher.category,
      });
      setInboxStatus(watcherId, videoId, "queued");
      res.json({ queued: enqueued });
    },
  );

  app.post(
    "/api/youtube/inbox/:watcherId/:videoId/dismiss",
    (req: Request<{ watcherId: string; videoId: string }>, res) => {
      const watcherId = Number(req.params.watcherId);
      const { videoId } = req.params;
      res.json({ updated: setInboxStatus(watcherId, videoId, "dismissed") });
    },
  );
}
