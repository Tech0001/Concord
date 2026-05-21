import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { TagPicker } from "@/components/TagPicker";
import { useToast } from "@/hooks/use-toast";
import { useCategory } from "@/hooks/use-category";
import { cn } from "@/lib/utils";
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
} from "lucide-react";

interface ChatSource {
  source_index: number;
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

type AskEvent =
  | { type: "conversation"; conversationId: string; userMessageId: string }
  | { type: "context"; sources: ChatSource[]; weakRetrieval: boolean }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "persisted"; assistantMessageId: string }
  | { type: "error"; error: string }
  | { type: "end" };

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

function newConversationStub(): ConversationDetail {
  return {
    id: "",
    title: null,
    pinned: false,
    message_count: 0,
    last_message_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    messages: [],
  };
}

export default function AI() {
  const { toast } = useToast();
  const { serverCategory } = useCategory();

  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [active, setActive] = useState<ConversationDetail>(newConversationStub());
  const [loadingConv, setLoadingConv] = useState(false);

  const [composer, setComposer] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [streamingSources, setStreamingSources] = useState<ChatSource[]>([]);
  const [weakRetrieval, setWeakRetrieval] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [channelFilter, setChannelFilter] = useState<string>("all");

  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState<number | undefined>(undefined);

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
        setActive(newConversationStub());
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
  }, [loadConversations, loadChannels]);

  const ask = useCallback(async () => {
    const question = composer.trim();
    if (!question || streaming) return;
    setComposer("");
    setStreaming(true);
    setStreamingText("");
    setStreamingSources([]);
    setWeakRetrieval(false);

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

    const ctl = new AbortController();
    abortRef.current = ctl;

    let serverConversationId = active.id || "";

    try {
      const res = await fetch("/api/llm/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          question,
          conversationId: active.id || undefined,
          channelIds: channelFilter === "all" ? undefined : [channelFilter],
          category: serverCategory || undefined,
        }),
      });

      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(text);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventMatch = block.match(/^event: (.+)$/m);
          const dataMatch = block.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);
          const evt = { type: event, ...data } as AskEvent;

          if (evt.type === "conversation") {
            serverConversationId = evt.conversationId;
            setActive((prev) => ({ ...prev, id: serverConversationId }));
          } else if (evt.type === "context") {
            setStreamingSources(evt.sources);
            setWeakRetrieval(evt.weakRetrieval);
            scrollToBottom();
          } else if (evt.type === "delta") {
            setStreamingText((s) => s + evt.text);
            scrollToBottom();
          } else if (evt.type === "error") {
            toast({ title: "Chat error", description: evt.error, variant: "destructive" });
          }
        }
      }

      if (serverConversationId) {
        await loadConversation(serverConversationId);
      }
      loadConversations();
    } catch (err) {
      if ((err as any)?.name === "AbortError") {
        toast({ title: "Cancelled", description: "Stopped the assistant mid-answer." });
      } else {
        toast({ title: "Ask failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
      }
    } finally {
      setStreaming(false);
      setStreamingText("");
      setStreamingSources([]);
      setWeakRetrieval(false);
      abortRef.current = null;
    }
  }, [composer, streaming, active.id, channelFilter, toast, loadConversation, loadConversations, scrollToBottom]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const newChat = useCallback(() => {
    if (streaming) return;
    setActive(newConversationStub());
    setComposer("");
  }, [streaming]);

  const deleteConversation = useCallback(async (id: string) => {
    if (!confirm("Delete this conversation? This cannot be undone.")) return;
    const r = await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
    if (!r.ok) {
      toast({ title: "Failed to delete", variant: "destructive" });
      return;
    }
    if (active.id === id) setActive(newConversationStub());
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
  }, []);

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
    void loadConversation(id);
  }, [loadConversation]);

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
        {renderSidebar(loadConversation, newChat)}
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

        <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto pr-1">
          {loadingConv && (
            <div className="flex items-center justify-center py-6 text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-3 w-3 animate-spin" />Loading conversation…
            </div>
          )}

          {!loadingConv && active.messages.length === 0 && !streaming && (
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

          {streaming && (
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
          Questions get answered from your transcribed videos. Citations link back to the source video at the exact moment.
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
                    title={`${src.video_title ?? "Source"} · ${fmtTimestamp(src.start_seconds)}`}
                    className="inline-flex items-center rounded bg-secondary px-1 py-0.5 font-mono text-[10px] text-foreground hover:bg-foreground hover:text-background"
                  >
                    [{n}]
                  </button>
                  {!inStream && (
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
      {sources.map((s) => (
        <li key={s.source_index} className="group rounded border bg-muted/30 px-2 py-1.5">
          <div className="flex items-baseline gap-1.5">
            <button
              onClick={() => onCitationClick(s)}
              className="rounded bg-secondary px-1 py-0.5 font-mono text-[10px] text-foreground hover:bg-foreground hover:text-background"
            >
              [{s.source_index}]
            </button>
            <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={s.video_title ?? ""}>
              {s.video_title ?? "(unknown video)"}
            </span>
            <span className="text-[10px] font-mono text-muted-foreground">{fmtTimestamp(s.start_seconds)}</span>
            <button
              onClick={() => onSaveCitation(s)}
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              title="Save as note"
            >
              <BookmarkPlus className="h-3 w-3" />
            </button>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-muted-foreground">
            {s.channel_name && <span>{s.channel_name}</span>}
            {s.speaker_name && <span>· {s.speaker_name}</span>}
            {s.score != null && <span className="font-mono">· score {s.score.toFixed(2)}</span>}
          </div>
          {s.excerpt && (
            <div className="mt-1 line-clamp-2 italic text-muted-foreground">"{s.excerpt}"</div>
          )}
        </li>
      ))}
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
              {source.speaker_name && ` · ${source.speaker_name}`}
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
