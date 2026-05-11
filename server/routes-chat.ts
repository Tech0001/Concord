import type { Express, Request, Response } from "express";
import { nanoid } from "nanoid";
import type { Pipeline } from "./pipeline";
import {
  listChatConversations, createChatConversation, getChatConversation,
  deleteChatConversation, updateChatConversation, appendChatMessage,
  setChatMessageStarred,
} from "./db";
import { askArchive, type ContextSource } from "./rag-chat";

/**
 * /api/chat/* — conversation CRUD + message star — plus the streaming
 * RAG /api/llm/ask endpoint that drives the AI page. Grouped together
 * because the ask endpoint persists into chat_conversations / messages
 * / sources, and any caller of one usually wants the other.
 */
export function registerChatRoutes(app: Express, pipeline: Pipeline): void {
  app.get("/api/chat/conversations", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ conversations: listChatConversations() });
  });

  app.get("/api/chat/conversations/:id", (req: Request<{ id: string }>, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const conv = getChatConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    res.json(conv);
  });

  app.delete("/api/chat/conversations/:id", (req: Request<{ id: string }>, res: Response) => {
    const ok = deleteChatConversation(req.params.id);
    if (!ok) return res.status(404).json({ error: "Conversation not found" });
    res.json({ success: true });
  });

  app.patch("/api/chat/conversations/:id", (req: Request<{ id: string }>, res: Response) => {
    const { title, pinned } = req.body || {};
    const updates: { title?: string | null; pinned?: boolean } = {};
    if (title !== undefined) updates.title = title === null ? null : String(title);
    if (pinned !== undefined) updates.pinned = !!pinned;
    const meta = updateChatConversation(req.params.id, updates);
    if (!meta) return res.status(404).json({ error: "Conversation not found" });
    res.json({ conversation: meta });
  });

  app.patch("/api/chat/messages/:id/star", (req: Request<{ id: string }>, res: Response) => {
    const starred = !!req.body?.starred;
    const ok = setChatMessageStarred(req.params.id, starred);
    if (!ok) return res.status(404).json({ error: "Message not found" });
    res.json({ success: true, starred });
  });

  // Streaming RAG ask endpoint. Body:
  //   { question, conversationId?, channelIds?, topK?, perVideoCap? }
  // Behavior:
  //   - Creates a conversation if none provided (title from first ~60 chars)
  //   - Persists the user message immediately (so refresh-mid-stream still
  //     shows the question)
  //   - Streams: context → delta… → done (or error)
  //   - On stream completion, persists the assistant message + sources atomically
  app.post("/api/llm/ask", async (req, res) => {
    const cfg = pipeline.getConfig().llm;
    if (!cfg.chatModel) {
      return res.status(400).json({ error: "No chat model configured (set on the AI page first)" });
    }
    if (!cfg.embeddingModel) {
      return res.status(400).json({ error: "No embedding model configured (needed for retrieval)" });
    }

    const question = String(req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "question is required" });

    let conversationId: string = req.body?.conversationId ? String(req.body.conversationId) : "";
    const channelIds: string[] | undefined = Array.isArray(req.body?.channelIds)
      ? req.body.channelIds.map(String)
      : undefined;
    const topK = req.body?.topK ? Number(req.body.topK) : undefined;
    const perVideoCap = req.body?.perVideoCap ? Number(req.body.perVideoCap) : undefined;

    // History for multi-turn — pass last 4 turns (2 exchanges) verbatim.
    let history: { role: "user" | "assistant"; content: string }[] = [];

    if (conversationId) {
      const existing = getChatConversation(conversationId);
      if (!existing) return res.status(404).json({ error: "Conversation not found" });
      history = existing.messages
        .slice(-4)
        .map((m) => ({ role: m.role, content: m.content }));
    } else {
      // Auto-title: first question, first ~60 chars, hard-trimmed at a word boundary.
      const trimmed = question.length <= 60 ? question : question.slice(0, 57).replace(/\s+\S*$/, "") + "…";
      conversationId = nanoid();
      createChatConversation({ id: conversationId, title: trimmed });
    }

    // Persist user message immediately so the conversation reflects state
    // even if the stream errors out mid-flight.
    const userMessageId = nanoid();
    appendChatMessage({
      id: userMessageId,
      conversationId,
      role: "user",
      content: question,
    });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sse = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sse("conversation", { conversationId, userMessageId });

    let assistantText = "";
    let sources: ContextSource[] = [];
    let errored = false;

    // Cancel the upstream generator if the client disconnects mid-stream.
    const abortCtl = new AbortController();
    res.on("close", () => { if (!res.writableEnded) abortCtl.abort(); });

    try {
      for await (const evt of askArchive({
        question,
        history,
        channelIds,
        topK,
        perVideoCap,
        chatModel: cfg.chatModel,
        embeddingModel: cfg.embeddingModel,
        signal: abortCtl.signal,
      })) {
        if (evt.type === "context") {
          sources = evt.sources;
          sse("context", { sources, weakRetrieval: evt.weakRetrieval });
        } else if (evt.type === "delta") {
          assistantText += evt.text;
          sse("delta", { text: evt.text });
        } else if (evt.type === "done") {
          sse("done", {});
        } else if (evt.type === "error") {
          errored = true;
          sse("error", { error: evt.error });
        }
      }
    } catch (err) {
      errored = true;
      sse("error", { error: err instanceof Error ? err.message : String(err) });
    }

    // Persist the assistant turn (+ sources) regardless of whether the
    // stream completed cleanly — even partial answers are worth keeping
    // when the user manually aborts or the LLM errors mid-generation.
    if (assistantText.length > 0 || sources.length > 0) {
      const assistantMessageId = nanoid();
      try {
        appendChatMessage({
          id: assistantMessageId,
          conversationId,
          role: "assistant",
          content: assistantText,
          model: cfg.chatModel,
          sources: sources.map((s) => ({
            sourceIndex: s.sourceIndex,
            videoId: s.videoId,
            channelId: s.channelId,
            segmentIndex: s.segmentIndex,
            startSeconds: s.startSeconds,
            endSeconds: s.endSeconds,
            speaker: s.speaker,
            excerpt: s.excerpt,
            score: s.score,
          })),
        });
        sse("persisted", { assistantMessageId });
      } catch (err) {
        sse("error", { error: `Failed to persist assistant message: ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    if (!errored) sse("end", {});
    res.end();
  });
}
