import type { Express, Request, Response } from "express";
import { nanoid } from "nanoid";
import type { Pipeline } from "./pipeline";
import {
  chat as llmChat,
  LlmConfigError,
  LlmHttpError,
  LlmUnreachableError,
} from "./llm";
import {
  addClipLink,
  addNoteAnchor,
  createTranscriptClip,
  CLIP_LINK_KINDS,
  type ClipLinkHandle,
  type ClipLinkKind,
  deleteClipTag,
  deleteTranscriptClip,
  getClipGraph,
  getClipMapLayout,
  type GraphEdgeType,
  getClipLinks,
  getQueueEntry,
  listAllClipTags,
  listRelatedTranscriptClips,
  listTranscriptClips,
  removeClipLink,
  removeNoteAnchor,
  renameClipTag,
  saveClipMapLayout,
  setClipTags,
  syncLegacyAnchorColumns,
  updateTranscriptClip,
} from "./db";

/**
 * All /api/clips/* routes — note (transcript_clips) CRUD, anchors, tags
 * (incl. AI suggest-tags), typed links, and the graph view that powers
 * the Map page.
 *
 * Takes the Pipeline singleton so the AI tag-suggestion endpoint can
 * read the configured chat model.
 */
export function registerNotesRoutes(app: Express, pipeline: Pipeline): void {
  app.get("/api/clips", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const requestedLimit = Number(req.query.limit);
      const requestedOffset = Number(req.query.offset);
      const tagsParam = typeof req.query.tags === "string" ? req.query.tags : "";
      const tags = tagsParam
        .split(",")
        .map(t => t.trim())
        .filter(Boolean);
      const result = listTranscriptClips({
        q: req.query.q ? String(req.query.q) : "",
        channelId: String(req.query.channelId || "all"),
        tags,
        category: req.query.category ? String(req.query.category) : undefined,
        limit: Number.isFinite(requestedLimit) ? requestedLimit : 100,
        offset: Number.isFinite(requestedOffset) ? requestedOffset : 0,
      });
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list clips" });
    }
  });

  app.get("/api/clips/graph", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const tagsParam = typeof req.query.tags === "string" ? req.query.tags : "";
      const edgeTypesParam = typeof req.query.edgeTypes === "string" ? req.query.edgeTypes : "";
      const tags = tagsParam.split(",").map(t => t.trim()).filter(Boolean);
      const knownEdgeTypes = new Set<GraphEdgeType>(["manual", "shared_tag", "same_video"]);
      const edgeTypes = edgeTypesParam
        .split(",")
        .map(t => t.trim())
        .filter((t): t is GraphEdgeType => knownEdgeTypes.has(t as GraphEdgeType));
      const requestedLimit = Number(req.query.limit);
      res.json(getClipGraph({
        q: req.query.q ? String(req.query.q) : undefined,
        channelId: req.query.channelId ? String(req.query.channelId) : undefined,
        tags,
        edgeTypes: edgeTypes.length ? edgeTypes : undefined,
        category: req.query.category ? String(req.query.category) : undefined,
        limit: Number.isFinite(requestedLimit) ? requestedLimit : undefined,
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to build graph" });
    }
  });

  app.get("/api/clips/graph/layout", (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const mapKey = typeof req.query.mapKey === "string" ? req.query.mapKey.trim() : "";
      if (!mapKey) return res.status(400).json({ error: "mapKey is required" });
      res.json({ nodes: getClipMapLayout(mapKey) });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load graph layout" });
    }
  });

  app.put("/api/clips/graph/layout", (req, res) => {
    try {
      const mapKey = String(req.body?.mapKey || "").trim();
      const nodes = Array.isArray(req.body?.nodes) ? req.body.nodes : [];
      if (!mapKey) return res.status(400).json({ error: "mapKey is required" });
      const result = saveClipMapLayout(mapKey, nodes.map((node: any) => ({
        nodeId: String(node.nodeId || ""),
        x: Number(node.x),
        y: Number(node.y),
        width: Number(node.width),
        height: Number(node.height),
      })));
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save graph layout" });
    }
  });

  app.get("/api/clips/tags", (_req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ tags: listAllClipTags() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list tags" });
    }
  });

  // AI tag suggestions for a clip quote. Best-effort — the TagPicker shows
  // a "Suggested" row when this returns; if anything goes wrong it just
  // doesn't show, no error toast (the user can still type tags by hand).
  app.post("/api/clips/suggest-tags", async (req, res) => {
    const quote = String(req.body?.quote || "").trim();
    if (!quote) return res.status(400).json({ error: "quote required" });

    const cfg = pipeline.getConfig().llm;
    const model = cfg.chatModel;
    if (!model) return res.status(400).json({ error: "no_chat_model", message: "No chat model configured" });

    // Cap the existing-tag list and the quote so we don't blow context on
    // big libraries / very long clips.
    const allTags = listAllClipTags();
    const existing = allTags.slice(0, 200);
    const existingList = existing.length
      ? existing.map((t) => `${t.tag} (${t.count})`).join("\n")
      : "(no tags exist yet — propose 3-5 reasonable starter tags)";
    const cappedQuote = quote.length > 2000 ? quote.slice(0, 2000) + "…" : quote;

    const systemPrompt = [
      "You suggest 3-5 short tags for a transcript clip in a personal research archive.",
      "Tags use lowercase with hyphens for spaces (e.g. \"oil\", \"middle-east\", \"fed-rate\").",
      "Hierarchical tags use dots (e.g. \"religion.end-times.rapture\").",
      "STRONGLY prefer tags from the EXISTING list. Propose new tags only when none of the existing ones fit.",
      "Output ONLY a JSON array of strings — no prose, no markdown, no explanation.",
      "Example output: [\"oil\", \"commodities\", \"middle-east\"]",
    ].join(" ");

    const userPrompt = `EXISTING TAGS:\n${existingList}\n\nCLIP:\n"${cappedQuote}"`;

    try {
      const reply = await llmChat({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.3,
        maxTokens: 120,
      });

      // Parse the first JSON array we find. Models sometimes wrap output in
      // prose despite our instructions; the regex is forgiving.
      const match = reply.match(/\[[\s\S]*?\]/);
      let suggestions: string[] = [];
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          if (Array.isArray(parsed)) {
            suggestions = parsed
              .filter((s) => typeof s === "string")
              .map((s) => String(s).trim().toLowerCase().replace(/\s+/g, "-"))
              .filter(Boolean);
          }
        } catch { /* fall through to empty */ }
      }
      // Dedupe and cap.
      suggestions = Array.from(new Set(suggestions)).slice(0, 8);

      res.json({ suggestions, model });
    } catch (err) {
      if (err instanceof LlmConfigError) return res.status(400).json({ error: err.message });
      if (err instanceof LlmUnreachableError) return res.status(503).json({ error: err.message });
      if (err instanceof LlmHttpError) return res.status(err.status).json({ error: err.message });
      res.status(500).json({ error: err instanceof Error ? err.message : "Unknown" });
    }
  });

  app.post("/api/clips/tags/rename", (req, res) => {
    try {
      const { from, to, includeDescendants } = req.body || {};
      if (!from || !to) {
        return res.status(400).json({ error: "from and to are required" });
      }
      const result = renameClipTag(String(from), String(to), Boolean(includeDescendants));
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to rename tag" });
    }
  });

  app.delete("/api/clips/tags/:tag", (req: Request<{ tag: string }>, res: Response) => {
    try {
      const removed = deleteClipTag(
        decodeURIComponent(req.params.tag),
        req.query.includeDescendants === "true",
      );
      res.json({ success: true, removed });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete tag" });
    }
  });

  // Create a note. Three valid input shapes:
  //   1. Standalone note: { title, note?, tags? } — anchors omitted or []
  //   2. Single-anchor legacy: { videoId, channelId, quote, ... }
  //   3. Multi-anchor: { title, anchors: [...], ... }
  app.post("/api/clips", (req, res) => {
    try {
      const {
        videoId, channelId, startSeconds, endSeconds, quote,
        note, title, channelName, uploadDate, tags, anchors,
      } = req.body;

      const hasAnchorsField = Array.isArray(anchors);
      const multiAnchor = hasAnchorsField && anchors.length > 0;
      const legacySingleAnchor = !hasAnchorsField && videoId && channelId && quote;
      const standalone = hasAnchorsField && anchors.length === 0;

      if (!multiAnchor && !legacySingleAnchor && !standalone) {
        return res.status(400).json({
          error: "Provide `anchors: []` for a standalone note, `anchors: [...]` for multi-anchor, or (videoId, channelId, quote) for legacy single-anchor input",
        });
      }

      const normalizedAnchors = hasAnchorsField
        ? anchors.map((a: any) => ({
            videoId:      a.videoId      != null ? String(a.videoId)      : null,
            channelId:    a.channelId    != null ? String(a.channelId)    : null,
            startSeconds: a.startSeconds != null ? Number(a.startSeconds) : null,
            endSeconds:   a.endSeconds   != null ? Number(a.endSeconds)   : null,
            excerpt:      a.excerpt      != null ? String(a.excerpt)      : null,
            documentId:   a.documentId   != null ? String(a.documentId)   : null,
            docStartChar: a.docStartChar != null ? Number(a.docStartChar) : null,
            docEndChar:   a.docEndChar   != null ? Number(a.docEndChar)   : null,
          }))
        : undefined;

      // Resolve a title fallback from the first anchor's video (if there is
      // one). Skip for doc-anchored notes — those use the document's title
      // already attached on read.
      let entryForFallback: ReturnType<typeof getQueueEntry> | undefined;
      if (multiAnchor) {
        const first = normalizedAnchors![0];
        if (first.videoId && first.channelId) {
          entryForFallback = getQueueEntry(first.videoId, first.channelId);
        }
      } else if (legacySingleAnchor) {
        entryForFallback = getQueueEntry(String(videoId), String(channelId));
      }

      const resolvedTitle = String(title || entryForFallback?.title || "Untitled note");

      const clip = createTranscriptClip({
        id: nanoid(),
        title: resolvedTitle,
        channelName: channelName !== undefined ? String(channelName) : null,
        uploadDate: uploadDate || entryForFallback?.upload_date || null,
        note: note ? String(note) : null,
        tags: Array.isArray(tags) ? tags.map(String) : undefined,
        ...(hasAnchorsField
          ? { anchors: normalizedAnchors }
          : {
              videoId: String(videoId),
              channelId: String(channelId),
              startSeconds: Number(startSeconds) || 0,
              endSeconds: Number(endSeconds) || Number(startSeconds) || 0,
              quote: String(quote),
            }),
      });

      res.json({ success: true, clip });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to save clip" });
    }
  });

  // Edit a note's title or body. Tags are managed by the existing
  // PATCH /api/clips/:clipId/tags endpoint; anchors via POST/DELETE
  // .../anchors[/ordinal]. Body: { title?, note? }
  app.patch("/api/clips/:clipId", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const { title, note } = req.body || {};
      const fields: { title?: string; note?: string | null } = {};
      if (title !== undefined) fields.title = String(title);
      if (note !== undefined)  fields.note  = note === null ? null : String(note);
      const updated = updateTranscriptClip(req.params.clipId, fields);
      if (!updated) return res.status(404).json({ error: "Note not found" });
      res.json({ note: updated });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to update note" });
    }
  });

  // Append an anchor to an existing note. Body: { videoId, channelId,
  // startSeconds?, endSeconds?, excerpt? }. Returns the new anchor's
  // ordinal so the client can address it later (e.g. for delete).
  app.post("/api/clips/:clipId/anchors", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const { videoId, channelId, startSeconds, endSeconds, excerpt, documentId, docStartChar, docEndChar } = req.body || {};
      // Either video pair OR document — addNoteAnchor enforces this too,
      // but a 400 here is more user-friendly than a 500.
      if (!documentId && (!videoId || !channelId)) {
        return res.status(400).json({ error: "Provide documentId, or videoId + channelId" });
      }
      const ordinal = addNoteAnchor(req.params.clipId, {
        videoId:      videoId      != null ? String(videoId)      : null,
        channelId:    channelId    != null ? String(channelId)    : null,
        startSeconds: startSeconds != null ? Number(startSeconds) : null,
        endSeconds:   endSeconds   != null ? Number(endSeconds)   : null,
        excerpt:      excerpt      != null ? String(excerpt)      : null,
        documentId:   documentId   != null ? String(documentId)   : null,
        docStartChar: docStartChar != null ? Number(docStartChar) : null,
        docEndChar:   docEndChar   != null ? Number(docEndChar)   : null,
      });
      res.json({ success: true, ordinal });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to add anchor" });
    }
  });

  // Remove an anchor by ordinal. Standalone (zero-anchor) notes allowed.
  app.delete("/api/clips/:clipId/anchors/:ordinal", (req: Request<{ clipId: string; ordinal: string }>, res: Response) => {
    try {
      const ordinal = Number(req.params.ordinal);
      if (!Number.isInteger(ordinal) || ordinal < 1) {
        return res.status(400).json({ error: "ordinal must be a positive integer" });
      }
      const removed = removeNoteAnchor(req.params.clipId, ordinal);
      if (!removed) return res.status(404).json({ error: "Anchor not found" });
      // Keep legacy single-anchor columns in sync with the new first anchor.
      syncLegacyAnchorColumns(req.params.clipId);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to remove anchor" });
    }
  });

  app.patch("/api/clips/:clipId/tags", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const { tags } = req.body || {};
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: "tags array is required" });
      }
      const stored = setClipTags(req.params.clipId, tags.map(String));
      res.json({ success: true, tags: stored });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to update tags" });
    }
  });

  app.get("/api/clips/related/:channelId/:videoId", (req: Request<{ channelId: string; videoId: string }>, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      const result = listRelatedTranscriptClips(
        req.params.videoId,
        req.params.channelId,
        req.query.excludeId ? String(req.query.excludeId) : undefined,
      );
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to list related clips" });
    }
  });

  app.delete("/api/clips/:clipId", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const deleted = deleteTranscriptClip(req.params.clipId);
      if (!deleted) return res.status(404).json({ error: "Clip not found" });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to delete clip" });
    }
  });

  app.get("/api/clips/:clipId/links", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ links: getClipLinks(req.params.clipId), kinds: CLIP_LINK_KINDS });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to load links" });
    }
  });

  app.post("/api/clips/:clipId/links", (req: Request<{ clipId: string }>, res: Response) => {
    try {
      const { toId, kind, note, fromHandle, toHandle, fromOrdinal, toOrdinal } = req.body || {};
      if (!toId || !kind) return res.status(400).json({ error: "toId and kind are required" });
      if (!CLIP_LINK_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of ${CLIP_LINK_KINDS.join(", ")}` });
      }
      const result = addClipLink(
        req.params.clipId,
        String(toId),
        kind as ClipLinkKind,
        note ? String(note) : null,
        fromHandle ? (String(fromHandle) as ClipLinkHandle) : null,
        toHandle ? (String(toHandle) as ClipLinkHandle) : null,
        Number.isFinite(Number(fromOrdinal)) ? Number(fromOrdinal) : null,
        Number.isFinite(Number(toOrdinal)) ? Number(toOrdinal) : null,
      );
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "Failed to add link" });
    }
  });

  app.delete(
    "/api/clips/:clipId/links/:toId/:kind",
    (req: Request<{ clipId: string; toId: string; kind: string }>, res: Response) => {
      try {
        if (!CLIP_LINK_KINDS.includes(req.params.kind as ClipLinkKind)) {
          return res.status(400).json({ error: "Unknown link kind" });
        }
        const fromOrd = Number(req.query.fromOrd ?? 0);
        const toOrd = Number(req.query.toOrd ?? 0);
        const result = removeClipLink(
          req.params.clipId,
          req.params.toId,
          req.params.kind as ClipLinkKind,
          Number.isFinite(fromOrd) ? fromOrd : 0,
          Number.isFinite(toOrd) ? toOrd : 0,
        );
        res.json({ success: true, ...result });
      } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : "Failed to remove link" });
      }
    },
  );
}
