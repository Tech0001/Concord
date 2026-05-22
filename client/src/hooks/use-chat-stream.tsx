import { useSyncExternalStore } from "react";

/**
 * Module-level singleton that owns the in-flight AI chat stream.
 *
 * The streaming work used to live inside the AI page component, which
 * meant navigating away (or accidentally re-rendering the tree) killed
 * the fetch via AbortController cleanup. Lifting it to a module-level
 * class fixes that: the singleton persists for the life of the app,
 * the AbortController is only fired by the explicit Stop button, and
 * the AI page subscribes via useSyncExternalStore so it picks up the
 * current state whenever it (re-)mounts.
 *
 * The server already persists the assistant message even when the
 * client disconnects, so completing-while-away leaves a fully-saved
 * conversation that the AI page reloads on return.
 *
 * One in-flight ask at a time globally — calling ask() while a stream
 * is running is a no-op. Components should disable their submit
 * controls based on `isStreaming` to avoid the silent drop.
 */

export interface ChatSource {
  source_index: number;
  source?: "video" | "doc";
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
  video_path?: string | null;
  md_path?: string | null;
  status?: string | null;
  is_live?: number | null;
  duration?: number | null;
  word_count?: number | null;
  videoPath?: string | null;
  mdPath?: string | null;
  isLive?: number | null;
  wordCount?: number | null;
  speakerName?: string | null;
  document_id?: string;
  doc_rel_path?: string;
  doc_title?: string;
  doc_heading_path?: string;
  doc_start_char?: number;
  doc_end_char?: number;
  documentId?: string;
  docRelPath?: string;
  docTitle?: string;
  docHeadingPath?: string;
  docStartChar?: number;
  docEndChar?: number;
}

export type AskEvent =
  | { type: "conversation"; conversationId: string; userMessageId: string }
  | { type: "context"; sources: ChatSource[]; weakRetrieval: boolean }
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "persisted"; assistantMessageId: string }
  | { type: "error"; error: string }
  | { type: "end" };

export interface AskArgs {
  question: string;
  /** When omitted, the server creates a new conversation and the
   *  resulting id is emitted via the "conversation" event. */
  conversationId?: string | null;
  channelIds?: string[];
  category?: string;
  sources?: ("video" | "audio" | "doc")[];
}

export interface ChatStreamSnapshot {
  /** True from ask() start through stream completion (or abort/error). */
  isStreaming: boolean;
  /** Server-confirmed conversation id once the "conversation" event
   *  arrives. Matches the conversationId argument when the caller
   *  passed one. Null before the event for a fresh conversation. */
  conversationId: string | null;
  /** The question text being asked. Used by the AI page to render an
   *  optimistic user message while the assistant reply streams. */
  pendingQuestion: string | null;
  streamingText: string;
  streamingSources: ChatSource[];
  weakRetrieval: boolean;
  error: string | null;
  /** Increments when a stream finishes (success, abort, OR error).
   *  Components watch this to know when to reload the conversation
   *  from the server so they pick up the persisted messages. */
  completionTick: number;
  /** Paired with completionTick — the id of the conversation that just
   *  finished. The AI page reloads this conversation on tick change.
   *  Null only before the first completion. */
  lastCompletedConversationId: string | null;
}

const EMPTY_STATE: ChatStreamSnapshot = {
  isStreaming: false,
  conversationId: null,
  pendingQuestion: null,
  streamingText: "",
  streamingSources: [],
  weakRetrieval: false,
  error: null,
  completionTick: 0,
  lastCompletedConversationId: null,
};

class ChatStream {
  private state: ChatStreamSnapshot = EMPTY_STATE;
  private listeners = new Set<() => void>();
  private abortCtl: AbortController | null = null;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  };

  getSnapshot = (): ChatStreamSnapshot => this.state;

  private setState(patch: Partial<ChatStreamSnapshot>): void {
    this.state = { ...this.state, ...patch };
    // forEach instead of for-of so this compiles under the TS target
    // we share with the server (no downlevelIteration).
    this.listeners.forEach((l) => l());
  }

  /** Start a new ask. No-op while another stream is in flight. The
   *  caller should disable their submit control based on
   *  snapshot.isStreaming to avoid this silent drop in the UI. */
  async ask(args: AskArgs): Promise<void> {
    if (this.state.isStreaming) return;
    const ctl = new AbortController();
    this.abortCtl = ctl;
    let serverConvId = args.conversationId || "";

    this.setState({
      isStreaming: true,
      conversationId: serverConvId || null,
      pendingQuestion: args.question,
      streamingText: "",
      streamingSources: [],
      weakRetrieval: false,
      error: null,
    });

    try {
      const res = await fetch("/api/llm/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          question: args.question,
          conversationId: args.conversationId || undefined,
          channelIds: args.channelIds,
          category: args.category,
          sources: args.sources && args.sources.length > 0 ? args.sources : undefined,
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
            serverConvId = evt.conversationId;
            this.setState({ conversationId: serverConvId });
          } else if (evt.type === "context") {
            this.setState({ streamingSources: evt.sources, weakRetrieval: evt.weakRetrieval });
          } else if (evt.type === "delta") {
            this.setState({ streamingText: this.state.streamingText + evt.text });
          } else if (evt.type === "error") {
            this.setState({ error: evt.error });
          }
        }
      }
    } catch (err: any) {
      // AbortError is the user pressing Stop — not really an error.
      // Server has already persisted whatever it had at the moment.
      if (err?.name !== "AbortError") {
        this.setState({ error: err instanceof Error ? err.message : String(err) });
      }
    } finally {
      this.setState({
        isStreaming: false,
        pendingQuestion: null,
        streamingText: "",
        streamingSources: [],
        weakRetrieval: false,
        completionTick: this.state.completionTick + 1,
        lastCompletedConversationId: serverConvId || null,
      });
      this.abortCtl = null;
    }
  }

  abort(): void {
    this.abortCtl?.abort();
  }

  clearError(): void {
    if (this.state.error) this.setState({ error: null });
  }
}

export const chatStream = new ChatStream();

/** React subscription to the singleton. Components use this exactly
 *  like a useState pair — when the singleton emits an update every
 *  subscribed component re-renders with the new snapshot. */
export function useChatStream(): ChatStreamSnapshot {
  return useSyncExternalStore(chatStream.subscribe, chatStream.getSnapshot, chatStream.getSnapshot);
}
