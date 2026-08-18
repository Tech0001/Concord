import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { DocDrawer, type DocDrawerEntry } from "@/components/DocDrawer";
import { chatStream, useChatStream } from "@/hooks/use-chat-stream";
import { TagPicker } from "@/components/TagPicker";
import { useToast } from "@/hooks/use-toast";
import { useCategory } from "@/hooks/use-category";
import { cn } from "@/lib/utils";
import {
  deleteChatDraft,
  loadActiveConversationId,
  loadChatDraft,
  saveActiveConversationId,
  saveChatDraft,
} from "@/lib/ai-chat-persistence";
import {
  ArrowUp,
  BookmarkPlus,
  ChevronRight,
  Filter,
  Loader2,
  Menu,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  Star,
  Trash2,
  X,
} from "lucide-react";

interface ChatSource {
  source_index: number;
  /** "video" (default) or "doc". Streaming context uses lowercase; the
   *  persisted shape uses snake_case but the discriminator is the
   *  same. Doc sources have empty video_id/channel_id placeholders. */
  source?: "video" | "doc" | "note";
  video_id: string;
  channel_id: string;
  segment_index: number | null;
  start_seconds: number | null;
  end_seconds: number | null;
  speaker: string | null;
  speaker_name: string | null;
  excerpt: string | null;
  score: number | null;
  video_title: string | null;
  channel_name: string | null;
  upload_date: string | null;
  /** Playback metadata so VideoDrawer can find the saved file. Streamed from
   *  the server during the ask flow and re-resolved on conversation reload
   *  (re-joined from video_queue, since file paths can change). */
  video_path?: string | null;
  md_path?: string | null;
  status?: string | null;
  is_live?: number | null;
  duration?: number | null;
  word_count?: number | null;
  // Streaming context event uses camelCase; conversation-reload uses snake_case.
  videoPath?: string | null;
  mdPath?: string | null;
  isLive?: number | null;
  wordCount?: number | null;
  speakerName?: string | null;
  // Doc-source fields — populated when source === "doc".
  document_id?: string;
  doc_rel_path?: string;
  doc_root_id?: string;
  doc_title?: string;
  doc_heading_path?: string;
  doc_start_char?: number;
  doc_end_char?: number;
  // camelCase variants from the streaming event payload
  documentId?: string;
  docRootId?: string;
  docRelPath?: string;
  docTitle?: string;
  docHeadingPath?: string;
  docStartChar?: number;
  docEndChar?: number;
  // Note-source fields.
  note_id?: string;
  note_title?: string;
  note_body?: string;
  note_tags?: string;
  noteId?: string;
  noteTitle?: string;
  noteTags?: string[];
}

interface ChatMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  is_starred: boolean;
  created_at: string;
  sources: ChatSource[];
}

interface ConversationMeta {
  id: string;
  title: string | null;
  pinned: boolean;
  message_count: number;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationDetail extends ConversationMeta {
  messages: ChatMessage[];
}

interface ChannelOption {
  id: string;
  name: string;
}

// AskEvent now lives in hooks/use-chat-stream.tsx alongside the
// singleton that consumes the SSE stream.

function fmtTimestamp(seconds: number | null): string {
  if (seconds == null) return "—";
  const safe = Math.max(0, Math.floor(seconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const min = 60_000, h = 60 * min, day = 24 * h;
  if (diff < min) return "just now";
  if (diff < h) return `${Math.floor(diff / min)}m`;
  if (diff < day) return `${Math.floor(diff / h)}h`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d`;
  return d.toLocaleDateString();
}

function parseCitations(text: string): Array<{ type: "text"; text: string } | { type: "cite"; indexes: number[]; raw: string }> {
  const out: Array<{ type: "text"; text: string } | { type: "cite"; indexes: number[]; raw: string }> = [];
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ type: "text", text: text.slice(last, m.index) });
    const indexes = m[1].split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    out.push({ type: "cite", indexes, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ type: "text", text: text.slice(last) });
  return out;
}

function newConversationStub(id = ""): ConversationDetail {
  return {
    id,
    title: null,
    pinned: false,
    message_count: 0,
    last_message_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [],
  };
}

type AiSourceScope =
  | { kind: "video"; videoId: string; channelId: string; title: string }
  | { kind: "doc"; documentId: string; title: string }
  | { kind: "note"; noteId: string; title: string };

function readAiSourceScope(): AiSourceScope | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const kind = params.get("scope");
  const title = params.get("title") || "Selected source";
  if (kind === "video") {
    const videoId = params.get("videoId") || "";
    const channelId = params.get("channelId") || "";
    return videoId && channelId ? { kind, videoId, channelId, title } : null;
  }
  if (kind === "doc") {
    const documentId = params.get("documentId") || "";
    return documentId ? { kind, documentId, title } : null;
  }
  if (kind === "note") {
    const noteId = params.get("noteId") || "";
    return noteId ? { kind, noteId, title } : null;
  }
  return null;
}

export default function AI() {
  const { toast } = useToast();
  const { serverCategory } = useCategory();
  const [location, navigate] = useLocation();
  const sourceScope = useMemo(() => readAiSourceScope(), [location]);
  const [initialActiveId] = useState(() => loadActiveConversationId(
    typeof window === "undefined" ? null : window.localStorage,
  ));

  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [active, setActive] = useState<ConversationDetail>(() => newConversationStub(initialActiveId));
  const [loadingConv, setLoadingConv] = useState(false);

  const [composer, setComposer] = useState(() => loadChatDraft(
    typeof window === "undefined" ? null : window.localStorage,
    initialActiveId,
  ));
  // Streaming state lives in a module-level singleton (see
  // hooks/use-chat-stream.tsx) so navigating away from this page
  // doesn't kill the in-flight fetch. The hook re-subscribes on
  // re-mount and the snapshot reflects current state including any
  // partial response that arrived while we were elsewhere.
  const streamSnap = useChatStream();
  const streaming = streamSnap.isStreaming;
  const streamingText = streamSnap.streamingText;
  const streamingSources = streamSnap.streamingSources;
  const weakRetrieval = streamSnap.weakRetrieval;
  const streamingForActive = streaming && (
    streamSnap.conversationId
      ? streamSnap.conversationId === active.id
      : active.id === ""
  );

  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>("all");

  // Source-kind scope for AI retrieval. Persisted in localStorage so
  // the user's last preference sticks across reloads. All three on by
  // default = search everything (same as omitting the filter).
  type ChatSourceKind = "video" | "audio" | "doc" | "note";
  const SOURCE_STORAGE_KEY = "concord-ai-sources-v1";
  const [enabledSources, setEnabledSources] = useState<Set<ChatSourceKind>>(() => {
    const all = new Set<ChatSourceKind>(["video", "audio", "doc", "note"]);
    if (typeof window === "undefined") return all;
    try {
      const stored = JSON.parse(window.localStorage.getItem(SOURCE_STORAGE_KEY) ?? "null");
      if (Array.isArray(stored) && stored.length > 0) {
        const valid = stored.filter((s: string) => s === "video" || s === "audio" || s === "doc" || s === "note");
        if (valid.length > 0) return new Set<ChatSourceKind>(valid as ChatSourceKind[]);
      }
    } catch { /* fall through */ }
    return all;
  });
  useEffect(() => {
    window.localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(Array.from(enabledSources)));
  }, [enabledSources]);

  // The server owns sent messages; local storage only remembers which saved
  // conversation was open and unsent composer text. Drafts are keyed per
  // conversation so switching threads and returning does not overwrite them.
  useEffect(() => {
    saveActiveConversationId(window.localStorage, active.id);
  }, [active.id]);
  useEffect(() => {
    saveChatDraft(window.localStorage, active.id, composer);
  }, [active.id, composer]);
  const toggleSource = (kind: ChatSourceKind) => {
    setEnabledSources((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) {
        if (next.size === 1) return next; // never let user disable everything
        next.delete(kind);
      } else {
        next.add(kind);
      }
      return next;
    });
  };

  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState<number | undefined>(undefined);
  const [drawerDoc, setDrawerDoc] = useState<DocDrawerEntry | null>(null);

  const [saveDialog, setSaveDialog] = useState<{ source: ChatSource; messageId: string; surroundingText: string } | null>(null);

  const threadRef = useRef<HTMLDivElement | null>(null);
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      const el = threadRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const r = await fetch("/api/chat/conversations");
      if (!r.ok) return;
      const data = await r.json() as { conversations: ConversationMeta[] };
      setConversations(data.conversations);
    } catch {
      // Conversations are nice-to-have; silent on errors.
    }
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    if (!id) { setActive(newConversationStub()); return; }
    setLoadingConv(true);
    try {
      const r = await fetch(`/api/chat/conversations/${id}`);
      if (!r.ok) {
        toast({ title: "Failed to load conversation", variant: "destructive" });
        if (r.status === 404) {
          deleteChatDraft(window.localStorage, id);
          saveActiveConversationId(window.localStorage, "");
          setActive(newConversationStub());
          setComposer(loadChatDraft(window.localStorage, ""));
        }
        return;
      }
      setActive(await r.json());
      scrollToBottom();
    } finally {
      setLoadingConv(false);
    }
  }, [toast, scrollToBottom]);

  const loadChannels = useCallback(async () => {
    // Channel list comes from pipeline config — that's what the Pipeline
    // page uses too, so we share the same source of truth (no separate
    // channels GET endpoint exists).
    try {
      const r = await fetch("/api/pipeline/config");
      if (!r.ok) return;
      const data = await r.json() as { channels?: { id: string; name: string }[] };
      setChannels(data.channels ?? []);
    } catch {
      // Optional filter source.
    }
  }, []);

  useEffect(() => {
    loadConversations();
    loadChannels();
    if (initialActiveId) void loadConversation(initialActiveId);
  }, [initialActiveId, loadConversation, loadConversations, loadChannels]);

  const ask = useCallback(async () => {
    const question = composer.trim();
    if (!question || streaming) return;
    setComposer("");

    // Optimistic user bubble stays local — the singleton tracks the
    // pending question, but we render the bubble inline here so it
    // appears in the message list immediately.
    const optimisticUser: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      conversation_id: active.id || "",
      role: "user",
      content: question,
      model: null,
      is_starred: false,
      created_at: new Date().toISOString(),
      sources: [],
    };
    setActive((prev) => ({ ...prev, messages: [...prev.messages, optimisticUser] }));
    scrollToBottom();

    // Delegate to the singleton — it owns the AbortController, the
    // fetch, and the SSE parsing. We don't await anything that lives
    // for the duration of the stream; the snapshot subscription
    // drives our re-renders. Awaiting ask() here is fine for the
    // "after the stream is over" branch but the page can navigate
    // away in the middle and the stream continues.
    await chatStream.ask({
      question,
      conversationId: active.id || undefined,
      channelIds: channelFilter === "all" ? undefined : [channelFilter],
      category: serverCategory || undefined,
      sources: enabledSources.size === 4 ? undefined : Array.from(enabledSources),
      videoKeys: sourceScope?.kind === "video" ? [{ videoId: sourceScope.videoId, channelId: sourceScope.channelId }] : undefined,
      documentIds: sourceScope?.kind === "doc" ? [sourceScope.documentId] : undefined,
      noteIds: sourceScope?.kind === "note" ? [sourceScope.noteId] : undefined,
    });
  }, [composer, streaming, active.id, channelFilter, serverCategory, enabledSources, sourceScope, scrollToBottom]);

  // When the singleton finishes (success / abort / error), reload the
  // active conversation so persisted messages replace the optimistic
  // user bubble + streaming preview. Also reloads the conversation
  // list so titles update. Conversation-id persistence separately handles
  // navigating away and returning after a stream has already completed.
  const lastTickRef = useRef(streamSnap.completionTick);
  useEffect(() => {
    if (streamSnap.completionTick === lastTickRef.current) return;
    lastTickRef.current = streamSnap.completionTick;
    const finishedId = streamSnap.lastCompletedConversationId;
    if (finishedId) {
      // If the user already moved to a different conversation, leave
      // active alone — they'll see the result next time they open the
      // one that just finished.
      if (active.id === finishedId || active.id === "" || active.id == null) {
        void loadConversation(finishedId);
      }
      loadConversations();
    }
    if (streamSnap.error) {
      toast({ title: "Ask failed", description: streamSnap.error, variant: "destructive" });
      chatStream.clearError();
    }
  }, [streamSnap.completionTick, streamSnap.lastCompletedConversationId, streamSnap.error, active.id, loadConversation, loadConversations, toast]);

  // When the conversation id is assigned mid-stream by the server,
  // surface it on the local `active` record so navigation / titles /
  // child queries can use it.
  useEffect(() => {
    if (streamSnap.conversationId && !active.id && streamSnap.isStreaming) {
      // Covers navigating away immediately after sending a brand-new chat,
      // before the page had time to receive and remember its server id.
      saveActiveConversationId(window.localStorage, streamSnap.conversationId);
      setActive((prev) => ({ ...prev, id: streamSnap.conversationId! }));
      void loadConversation(streamSnap.conversationId);
    }
  }, [streamSnap.conversationId, streamSnap.isStreaming, active.id, loadConversation]);

  const stop = useCallback(() => {
    chatStream.abort();
  }, []);

  const newChat = useCallback(() => {
    if (streaming) return;
    deleteChatDraft(window.localStorage, "");
    saveActiveConversationId(window.localStorage, "");
    setActive(newConversationStub());
    setComposer("");
  }, [streaming]);

  const selectConversation = useCallback((id: string) => {
    // Switch the id and its draft in the same render, then hydrate messages.
    // This prevents the target draft from briefly being saved under the
    // conversation the user just left.
    setActive(newConversationStub(id));
    setComposer(loadChatDraft(window.localStorage, id));
    void loadConversation(id);
  }, [loadConversation]);

  const deleteConversation = useCallback(async (id: string) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    const r = await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
    if (!r.ok) {
      toast({ title: "Failed to delete", variant: "destructive" });
      return;
    }
    deleteChatDraft(window.localStorage, id);
    if (active.id === id) {
      saveActiveConversationId(window.localStorage, "");
      setActive(newConversationStub());
      setComposer("");
    }
    loadConversations();
  }, [active.id, loadConversations, toast]);

  const togglePin = useCallback(async (conv: ConversationMeta) => {
    const r = await fetch(`/api/chat/conversations/${conv.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned: !conv.pinned }),
    });
    if (r.ok) loadConversations();
  }, [loadConversations]);

  const renameConversation = useCallback(async (id: string) => {
    const current = conversations.find((c) => c.id === id) ?? active;
    const next = prompt("Rename conversation:", current.title ?? "");
    if (next == null) return;
    const r = await fetch(`/api/chat/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: next.trim() || null }),
    });
    if (r.ok) {
      loadConversations();
      if (active.id === id) loadConversation(id);
    }
  }, [active, conversations, loadConversations, loadConversation]);

  const toggleStar = useCallback(async (messageId: string, starred: boolean) => {
    const r = await fetch(`/api/chat/messages/${messageId}/star`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred }),
    });
    if (r.ok) {
      setActive((prev) => ({
        ...prev,
        messages: prev.messages.map((m) => m.id === messageId ? { ...m, is_starred: starred } : m),
      }));
    }
  }, []);

  const openSource = useCallback((src: ChatSource) => {
    if (src.source === "note") {
      const noteId = src.note_id ?? src.noteId;
      if (noteId) navigate(`/notes?noteId=${encodeURIComponent(noteId)}`);
      return;
    }
    // Doc sources open in a side drawer so the chat stays visible —
    // mirrors the VideoDrawer pattern for video citations. The drawer
    // does its own scroll-to-excerpt + highlight after the markdown
    // renders. "Open in Docs page" inside the drawer is the escape
    // hatch for users who want the full file tree + filters.
    // Also accept the "doc looks like a doc" heuristic for pre-fix
    // persisted rows (source is NULL/"video" but video_id is empty
    // and we have a doc path) so users don't have to re-ask just to
    // click a citation.
    const looksLikeDoc = src.source === "doc"
      || (!src.video_id && (src.doc_rel_path || src.docRelPath));
    if (looksLikeDoc) {
      const docPath = src.doc_rel_path ?? src.docRelPath;
      if (!docPath) {
        console.warn("[ai] doc citation has no path — likely a pre-fix persisted row");
        return;
      }
      setDrawerDoc({
        documentId: src.document_id ?? src.documentId,
        rootId: src.doc_root_id ?? src.docRootId,
        relPath: docPath,
        title: src.doc_title ?? src.docTitle ?? docPath,
        excerpt: src.excerpt,
        subtitle: src.doc_heading_path ?? src.docHeadingPath ?? null,
      });
      return;
    }
    if (!src.video_id || !src.channel_id) return;
    // Bridge between the streaming context shape (camelCase) and the
    // conversation-reload shape (snake_case). Either may be present.
    setDrawerVideo({
      video_id: src.video_id,
      channel_id: src.channel_id,
      channel_name: src.channel_name,
      title: src.video_title || "Source video",
      upload_date: src.upload_date,
      status: src.status ?? undefined,
      is_live: src.is_live ?? src.isLive ?? undefined,
      video_path: src.video_path ?? src.videoPath ?? null,
      md_path: src.md_path ?? src.mdPath ?? null,
      word_count: src.word_count ?? src.wordCount ?? 0,
      duration: src.duration ?? null,
    });
    setDrawerSeconds(src.start_seconds ?? undefined);
  }, [navigate]);

  const saveSourceAsNote = useCallback((src: ChatSource, messageId: string) => {
    const message = active.messages.find((m) => m.id === messageId);
    setSaveDialog({
      source: src,
      messageId,
      surroundingText: message?.content ?? "",
    });
  }, [active.messages]);

  const groupedConversations = useMemo(() => {
    const pinned = conversations.filter((c) => c.pinned);
    const recent = conversations.filter((c) => !c.pinned);
    return { pinned, recent };
  }, [conversations]);

  const [conversationsSheetOpen, setConversationsSheetOpen] = useState(false);

  // Closing the sheet after a tap is what makes the mobile experience feel
  // right — wrap the conversation actions so each one auto-dismisses.
  const handleSelectFromSheet = useCallback((id: string) => {
    setConversationsSheetOpen(false);
    selectConversation(id);
  }, [selectConversation]);

  const newChatFromSheet = useCallback(() => {
    setConversationsSheetOpen(false);
    newChat();
  }, [newChat]);

  // Shared sidebar body — rendered both as the desktop aside and inside the
  // mobile sheet. Takes a flag so the desktop variant doesn't auto-close.
  const renderSidebar = (onSelect: (id: string) => void, onNew: () => void) => (
    <>
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={onNew} disabled={streaming} className="flex-1 justify-start">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> New chat
        </Button>
        <Link href="/settings">
          <Button size="icon" variant="ghost" className="h-8 w-8" title="Settings">
            <SettingsIcon className="h-3.5 w-3.5" />
          </Button>
        </Link>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto">
        {groupedConversations.pinned.length > 0 && (
          <ConversationGroup
            label="Pinned"
            items={groupedConversations.pinned}
            activeId={active.id}
            onSelect={onSelect}
            onDelete={deleteConversation}
            onTogglePin={togglePin}
            onRename={renameConversation}
          />
        )}
        <ConversationGroup
          label={groupedConversations.pinned.length > 0 ? "Recent" : "Conversations"}
          items={groupedConversations.recent}
          activeId={active.id}
          onSelect={onSelect}
          onDelete={deleteConversation}
          onTogglePin={togglePin}
          onRename={renameConversation}
        />
        {conversations.length === 0 && (
          <div className="rounded-md border border-dashed bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">
            No conversations yet. Ask the archive something.
          </div>
        )}
      </div>
    </>
  );

  return (
    <div className="mx-auto flex max-w-7xl gap-3 px-3 py-3" style={{ height: "calc(100vh - 48px)" }}>
      <aside className="hidden w-64 shrink-0 flex-col gap-2 md:flex">
        {renderSidebar(selectConversation, newChat)}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex items-center justify-between gap-3 border-b pb-2">
          <div className="flex min-w-0 items-center gap-2">
            <Sheet open={conversationsSheetOpen} onOpenChange={setConversationsSheetOpen}>
              <SheetTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 md:hidden"
                  aria-label="Open conversations"
                  title="Conversations"
                >
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 p-0">
                <SheetHeader className="border-b p-3">
                  <SheetTitle className="text-sm">Conversations</SheetTitle>
                </SheetHeader>
                <div className="flex h-[calc(100%-49px)] flex-col gap-2 p-3">
                  {renderSidebar(handleSelectFromSheet, newChatFromSheet)}
                </div>
              </SheetContent>
            </Sheet>
            <MessageSquare className="hidden h-4 w-4 shrink-0 text-muted-foreground md:block" />
            <h1 className="truncate text-sm font-semibold">
              {active.title || (active.id ? "Untitled conversation" : "New chat")}
            </h1>
            {active.id && (
              <Button size="icon" variant="ghost" className="h-6 w-6" title="Rename" onClick={() => renameConversation(active.id)}>
                <Pencil className="h-3 w-3 text-muted-foreground" />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Source-kind scope chips — toggle audio / video / docs.
             *  Last one can't be deselected so the chat always has
             *  something to retrieve from. */}
            <div className="hidden items-center gap-1 rounded-md border bg-card p-0.5 text-xs sm:flex" role="group" aria-label="Source scope">
              {(["audio", "video", "doc", "note"] as const).map((kind) => {
                const on = enabledSources.has(kind);
                const label = kind === "doc" ? "Docs" : kind === "note" ? "Notes" : kind === "audio" ? "Audio" : "Video";
                return (
                  <button
                    key={kind}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleSource(kind)}
                    title={on ? `Searching ${label.toLowerCase()}` : `${label} excluded — click to include`}
                    className={cn(
                      "rounded px-2 py-0.5 transition-colors",
                      on ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Filter className="h-3.5 w-3.5" />
              <Select value={channelFilter} onValueChange={setChannelFilter}>
                <SelectTrigger className="h-7 w-[120px] text-xs md:w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs">All channels</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </header>

        {sourceScope && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-primary/25 bg-primary/5 px-3 py-2 text-xs">
            <div className="min-w-0">
              <span className="font-medium">Scoped to {sourceScope.kind === "doc" ? "document" : sourceScope.kind}: </span>
              <span className="truncate text-muted-foreground">{sourceScope.title}</span>
            </div>
            <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => navigate("/ai")} title="Search the full archive instead">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
          {loadingConv && (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />Loading conversation…
            </div>
          )}

          {!loadingConv && active.messages.length === 0 && !streamingForActive && (
            <EmptyState />
          )}

          {active.messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              onCitationClick={openSource}
              onSaveCitation={(src) => saveSourceAsNote(src, m.id)}
              onToggleStar={() => toggleStar(m.id, !m.is_starred)}
            />
          ))}

          {streamingForActive && (
            <StreamingBubble
              text={streamingText}
              sources={streamingSources}
              weakRetrieval={weakRetrieval}
              onCitationClick={openSource}
            />
          )}
        </div>

        <Composer
          value={composer}
          onChange={setComposer}
          onSubmit={ask}
          onStop={stop}
          streaming={streaming}
        />
      </main>

      <VideoDrawer
        open={!!drawerVideo}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
        onOpenChange={(open) => { if (!open) setDrawerVideo(null); }}
      />

      <DocDrawer
        open={!!drawerDoc}
        doc={drawerDoc}
        onOpenChange={(open) => { if (!open) setDrawerDoc(null); }}
      />

      {saveDialog && (
        <SaveAsNoteDialog
          source={saveDialog.source}
          surroundingText={saveDialog.surroundingText}
          onClose={() => setSaveDialog(null)}
          onSaved={() => {
            setSaveDialog(null);
            toast({ title: "Saved as note", description: "Find it on the Notes page." });
          }}
        />
      )}
    </div>
  );
}

function ConversationGroup({
  label, items, activeId, onSelect, onDelete, onTogglePin, onRename,
}: {
  label: string;
  items: ConversationMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (conv: ConversationMeta) => void;
  onRename: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <ul className="space-y-0.5">
        {items.map((c) => (
          <li key={c.id}>
            <div
              className={cn(
                "group flex items-center gap-1 rounded-md px-2 py-1.5 text-xs hover:bg-secondary",
                activeId === c.id && "bg-secondary",
              )}
            >
              <button
                onClick={() => onSelect(c.id)}
                className="min-w-0 flex-1 truncate text-left"
                title={c.title ?? "Untitled"}
              >
                {c.title ?? "Untitled"}
              </button>
              <div className="hidden gap-0.5 group-hover:flex">
                <button
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => onTogglePin(c)}
                  title={c.pinned ? "Unpin" : "Pin"}
                >
                  {c.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                </button>
                <button
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  onClick={() => onRename(c.id)}
                  title="Rename"
                >
                  <Pencil className="h-3 w-3" />
                </button>
                <button
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  onClick={() => onDelete(c.id)}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-md space-y-3 text-center">
        <Sparkles className="mx-auto h-8 w-8 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Ask the archive</h2>
        <p className="text-xs text-muted-foreground">
          Questions get answered from your video/audio transcripts, documents, and research notes. Citations link back to the original source.
        </p>
        <div className="space-y-1 pt-2 text-left text-[11px] text-muted-foreground">
          <div className="rounded-md border bg-muted/30 px-2 py-1.5">
            "What does the archive say about X?"
          </div>
          <div className="rounded-md border bg-muted/30 px-2 py-1.5">
            "Find times Bob disagrees with Alice on Y."
          </div>
          <div className="rounded-md border bg-muted/30 px-2 py-1.5">
            "Summarize what's been said about Z across all the channels."
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onCitationClick,
  onSaveCitation,
  onToggleStar,
}: {
  message: ChatMessage;
  onCitationClick: (src: ChatSource) => void;
  onSaveCitation: (src: ChatSource) => void;
  onToggleStar: () => void;
}) {
  const isUser = message.role === "user";
  const sourcesByIndex = useMemo(() => {
    const m = new Map<number, ChatSource>();
    for (const s of message.sources) m.set(s.source_index, s);
    return m;
  }, [message.sources]);

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      <div className={cn(
        "max-w-[88%] rounded-lg px-3 py-2 text-sm",
        isUser ? "bg-primary text-primary-foreground" : "bg-card border",
      )}>
        <RichText
          text={message.content}
          sourcesByIndex={sourcesByIndex}
          onCitationClick={onCitationClick}
          onSaveCitation={onSaveCitation}
        />
      </div>

      {!isUser && message.sources.length > 0 && (
        <details className="max-w-[88%] text-xs text-muted-foreground">
          <summary className="cursor-pointer list-none">
            <span className="inline-flex items-center gap-1 hover:text-foreground">
              <ChevronRight className="h-3 w-3" />
              {message.sources.length} sources
            </span>
          </summary>
          <SourcesList sources={message.sources} onCitationClick={onCitationClick} onSaveCitation={onSaveCitation} />
        </details>
      )}

      {!isUser && (
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <button
            onClick={onToggleStar}
            className={cn("inline-flex items-center gap-0.5 hover:text-foreground", message.is_starred && "text-amber-500 hover:text-amber-600")}
            title={message.is_starred ? "Unstar" : "Star this answer"}
          >
            <Star className={cn("h-3 w-3", message.is_starred && "fill-current")} />
            {message.is_starred ? "Starred" : "Star"}
          </button>
          {message.model && <span className="font-mono">{message.model}</span>}
          <span>{fmtRelative(message.created_at)}</span>
        </div>
      )}
    </div>
  );
}

function StreamingBubble({
  text, sources, weakRetrieval, onCitationClick,
}: {
  text: string;
  sources: ChatSource[];
  weakRetrieval: boolean;
  onCitationClick: (src: ChatSource) => void;
}) {
  const sourcesByIndex = useMemo(() => {
    const m = new Map<number, ChatSource>();
    for (const s of sources) m.set(s.source_index, s);
    return m;
  }, [sources]);

  return (
    <div className="flex flex-col gap-1.5 items-start">
      {weakRetrieval && sources.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-700 dark:text-amber-300">
          Weak retrieval — top source score is low. Verify the citations carefully.
        </div>
      )}
      <div className="max-w-[88%] rounded-lg border bg-card px-3 py-2 text-sm">
        {text.length === 0 ? (
          <span className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {sources.length === 0 ? "Searching the archive…" : "Thinking…"}
          </span>
        ) : (
          <RichText
            text={text}
            sourcesByIndex={sourcesByIndex}
            onCitationClick={onCitationClick}
            onSaveCitation={() => { /* disabled mid-stream */ }}
            inStream
          />
        )}
      </div>
    </div>
  );
}

function RichText({
  text, sourcesByIndex, onCitationClick, onSaveCitation, inStream,
}: {
  text: string;
  sourcesByIndex: Map<number, ChatSource>;
  onCitationClick: (src: ChatSource) => void;
  onSaveCitation: (src: ChatSource) => void;
  inStream?: boolean;
}) {
  const parts = useMemo(() => parseCitations(text), [text]);
  return (
    <div className="whitespace-pre-wrap break-words">
      {parts.map((p, i) => {
        if (p.type === "text") return <span key={i}>{p.text}</span>;
        return (
          <span key={i} className="inline-flex flex-wrap items-center gap-0.5 align-baseline">
            {p.indexes.map((n) => {
              const src = sourcesByIndex.get(n);
              if (!src) return <span key={n} className="rounded bg-secondary px-1 py-0.5 font-mono text-[10px] text-muted-foreground">[{n}]</span>;
              return (
                <span key={n} className="group/cite inline-flex items-center gap-0.5">
                  <button
                    onClick={() => onCitationClick(src)}
                    title={src.source === "note"
                      ? (src.note_title ?? src.noteTitle ?? "Research note")
                      : src.source === "doc"
                        ? (src.doc_title ?? src.docTitle ?? "Document")
                        : `${src.video_title ?? "Source"} · ${fmtTimestamp(src.start_seconds)}`}
                    className="inline-flex items-center rounded bg-secondary px-1 py-0.5 font-mono text-[10px] text-foreground hover:bg-foreground hover:text-background"
                  >
                    [{n}]
                  </button>
                  {!inStream && src.source !== "note" && (
                    <button
                      onClick={() => onSaveCitation(src)}
                      className="inline-flex items-center rounded bg-secondary px-1 py-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-foreground hover:text-background group-hover/cite:opacity-100"
                      title="Save as note"
                    >
                      <BookmarkPlus className="h-3 w-3" />
                    </button>
                  )}
                </span>
              );
            })}
          </span>
        );
      })}
    </div>
  );
}

function SourcesList({
  sources, onCitationClick, onSaveCitation,
}: {
  sources: ChatSource[];
  onCitationClick: (src: ChatSource) => void;
  onSaveCitation: (src: ChatSource) => void;
}) {
  return (
    <ul className="mt-1 space-y-1">
      {sources.map((s) => {
        const isDoc = s.source === "doc";
        const isNote = s.source === "note";
        const docPath = s.doc_rel_path ?? s.docRelPath ?? null;
        const docTitle = s.doc_title ?? s.docTitle ?? null;
        const headingPath = s.doc_heading_path ?? s.docHeadingPath ?? null;
        const noteTitle = s.note_title ?? s.noteTitle ?? null;
        const noteTags = s.note_tags
          ? s.note_tags.split(",").map(tag => tag.trim()).filter(Boolean)
          : (s.noteTags ?? []);
        return (
          <li key={s.source_index} className="group rounded border bg-muted/30 px-2 py-1.5">
            <div className="flex items-baseline gap-1.5">
              <button
                onClick={() => onCitationClick(s)}
                className="rounded bg-secondary px-1 py-0.5 font-mono text-[10px] text-foreground hover:bg-foreground hover:text-background"
              >
                [{s.source_index}]
              </button>
              {isDoc && (
                <span className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
                  doc
                </span>
              )}
              {isNote && (
                <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                  note
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={isNote ? (noteTitle ?? "") : isDoc ? (docPath ?? "") : (s.video_title ?? "")}>
                {isNote ? (noteTitle || "(untitled note)") : isDoc ? (docTitle || docPath || "(unknown doc)") : (s.video_title ?? "(unknown video)")}
              </span>
              {!isDoc && !isNote && (
                <span className="text-[10px] font-mono text-muted-foreground">{fmtTimestamp(s.start_seconds)}</span>
              )}
              {!isNote && (
                <button
                  onClick={() => onSaveCitation(s)}
                  className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  title="Save as note"
                >
                  <BookmarkPlus className="h-3 w-3" />
                </button>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
              {isNote ? (
                noteTags.length > 0 ? <span>{noteTags.join(" · ")}</span> : null
              ) : isDoc ? (
                headingPath ? <span>{headingPath}</span> : null
              ) : (
                <>
                  {s.channel_name && <span>{s.channel_name}</span>}
                  {(s.speaker_name ?? s.speakerName) && (
                    <span>· {s.speaker_name ?? s.speakerName}</span>
                  )}
                </>
              )}
              {s.score != null && <span className="font-mono">· score {s.score.toFixed(2)}</span>}
            </div>
            {s.excerpt && (
              <div className="mt-1 line-clamp-2 italic text-muted-foreground">"{s.excerpt}"</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Composer({
  value, onChange, onSubmit, onStop, streaming,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  streaming: boolean;
}) {
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };
  return (
    <div className="flex items-end gap-2 border-t pt-2">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={streaming ? "Generating…" : "Ask the archive… (Enter to send, Shift+Enter for newline)"}
        rows={2}
        disabled={streaming}
        className="flex min-h-[44px] w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      />
      {streaming ? (
        <Button onClick={onStop} variant="outline" className="h-11 w-11 p-0" title="Stop generating">
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button onClick={onSubmit} disabled={!value.trim()} className="h-11 w-11 p-0" title="Send (Enter)">
          <ArrowUp className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

interface TagOption { tag: string; count: number; }

interface ExistingNote { id: string; title: string; anchor_count: number; }

function SaveAsNoteDialog({
  source, surroundingText, onClose, onSaved,
}: {
  source: ChatSource;
  surroundingText: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [title, setTitle] = useState(`Note on ${source.video_title ?? "source"}`);
  const [body, setBody] = useState(surroundingText);
  const [tags, setTags] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [existingNotes, setExistingNotes] = useState<ExistingNote[]>([]);
  const [noteSearch, setNoteSearch] = useState("");
  const [pickedNoteId, setPickedNoteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  // Load tags and existing notes on mount. Tags power the TagPicker; notes
  // populate the "add to existing" picker so the user can route the new
  // anchor into a note they've already built.
  const loadTags = useCallback(async () => {
    try {
      const r = await fetch("/api/clips/tags");
      if (!r.ok) return;
      const data = await r.json() as { tags: TagOption[] };
      setTagOptions(data.tags ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    loadTags();
    (async () => {
      try {
        const r = await fetch("/api/clips?limit=200");
        if (!r.ok) return;
        const data = await r.json() as { rows: { id: string; title: string; anchors: unknown[] }[] };
        setExistingNotes((data.rows ?? []).map((n) => ({
          id: n.id, title: n.title, anchor_count: Array.isArray(n.anchors) ? n.anchors.length : 1,
        })));
      } catch {}
    })();
  }, [loadTags]);

  const filteredNotes = useMemo(() => {
    const q = noteSearch.trim().toLowerCase();
    if (!q) return existingNotes;
    return existingNotes.filter((n) => n.title.toLowerCase().includes(q));
  }, [existingNotes, noteSearch]);

  const save = async () => {
    setSaving(true);
    try {
      if (mode === "new") {
        const r = await fetch("/api/clips", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim() || "Untitled note",
            note: body.trim() || null,
            tags,
            anchors: [{
              videoId: source.video_id,
              channelId: source.channel_id,
              startSeconds: source.start_seconds,
              endSeconds: source.end_seconds,
              excerpt: source.excerpt,
            }],
          }),
        });
        if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`));
      } else {
        if (!pickedNoteId) throw new Error("Pick a note to add to");
        const r = await fetch(`/api/clips/${pickedNoteId}/anchors`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoId: source.video_id,
            channelId: source.channel_id,
            startSeconds: source.start_seconds,
            endSeconds: source.end_seconds,
            excerpt: source.excerpt,
          }),
        });
        if (!r.ok) throw new Error(await r.text().catch(() => `HTTP ${r.status}`));
      }
      onSaved();
    } catch (err) {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const canSave = !saving && (mode === "new" ? !!title.trim() : !!pickedNoteId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm" onClick={onClose}>
      <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BookmarkPlus className="h-4 w-4" /> Save as note
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded border bg-muted/30 px-2.5 py-1.5 text-xs">
            <div className="font-medium">{source.video_title}</div>
            <div className="text-muted-foreground">
              {source.channel_name} · {fmtTimestamp(source.start_seconds)}
              {(source.speaker_name ?? source.speakerName) && ` · ${source.speaker_name ?? source.speakerName}`}
            </div>
            {source.excerpt && <div className="mt-1 italic text-muted-foreground">"{source.excerpt}"</div>}
          </div>

          <div className="flex rounded-md border bg-muted p-0.5 text-xs">
            <button
              onClick={() => setMode("new")}
              className={cn(
                "flex-1 rounded px-2 py-1 transition-colors",
                mode === "new" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              New note
            </button>
            <button
              onClick={() => setMode("existing")}
              className={cn(
                "flex-1 rounded px-2 py-1 transition-colors",
                mode === "existing" ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              Add to existing {existingNotes.length > 0 && <span className="text-muted-foreground">({existingNotes.length})</span>}
            </button>
          </div>

          {mode === "new" ? (
            <>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Title</label>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} className="text-sm" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Your note (from the AI's answer)</label>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={5}
                  className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Tags</label>
                <TagPicker value={tags} onChange={setTags} options={tagOptions} size="sm" placeholder="Pick or add tags…" onOpen={loadTags} />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Input
                value={noteSearch}
                onChange={(e) => setNoteSearch(e.target.value)}
                placeholder="Search your notes…"
                className="text-sm"
              />
              <div className="max-h-60 overflow-y-auto rounded-md border">
                {filteredNotes.length === 0 && (
                  <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                    {existingNotes.length === 0 ? "No notes yet — switch to 'New note' to create one." : "No notes match that search."}
                  </div>
                )}
                {filteredNotes.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => setPickedNoteId(n.id)}
                    className={cn(
                      "block w-full border-b px-2.5 py-1.5 text-left text-sm last:border-0 hover:bg-secondary",
                      pickedNoteId === n.id && "bg-secondary",
                    )}
                  >
                    <div className="truncate">{n.title}</div>
                    <div className="text-[10px] text-muted-foreground">{n.anchor_count} anchor{n.anchor_count === 1 ? "" : "s"}</div>
                  </button>
                ))}
              </div>
              {pickedNoteId && (
                <div className="text-[11px] text-muted-foreground">
                  This citation will be added as a new anchor on the selected note. Title, body, and tags remain unchanged.
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={!canSave}>
              {saving ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
