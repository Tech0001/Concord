import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/ipc.ts";
import { useToast } from "../ui/Toasts.tsx";
import {
  EMPTY_FILTER,
  type AiConfig,
  type ChatContext,
  type ChatDetail,
  type Conversation,
  type SearchFilter,
} from "./types.ts";
export type AskIntent = {
  context: ChatContext;
  question?: string;
  recordingId?: string;
  recordingTitle?: string;
};
function useChatStore() {
  const toast = useToast();
  const [open, setOpen] = useState(false),
    [config, setConfig] = useState<AiConfig>();
  const [list, setList] = useState<Conversation[]>([]),
    [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<ChatDetail>(),
    [question, setQuestion] = useState("");
  const [context, setContext] = useState<ChatContext>("archive"),
    [recordingId, setRecordingId] = useState(""),
    [recordingTitle, setRecordingTitle] = useState("");
  const [semantic, setSemantic] = useState(true),
    [filter, setFilter] = useState<SearchFilter>({ ...EMPTY_FILTER });
  const [busy, setBusy] = useState(false),
    [stream, setStream] = useState("");
  const active = useRef(""),
    sending = useRef(false),
    loadSerial = useRef(0),
    drafts = useRef(new Map<string, string>());
  const close = useCallback(() => setOpen(false), []);
  const reload = useCallback(async () => {
    const rows = await api.aiConversations();
    setList(rows);
    return rows;
  }, []);
  const refresh = useCallback(async () => {
    try {
      setConfig(await api.aiConfig());
      await reload();
    } catch (e) {
      toast.error(e);
    }
  }, [reload, toast]);
  const select = async (id: string) => {
    if (sending.current) return;
    const serial = ++loadSerial.current;
    active.current = id;
    setSelected(id);
    setDetail(undefined);
    if (!id) return;
    try {
      const d = await api.aiReadChat(id);
      if (serial === loadSerial.current) setDetail(d);
    } catch (e) {
      toast.error(e);
    }
  };
  const changeContext = (
    next: ChatContext,
    id = recordingId,
    title = recordingTitle,
    prefill?: string,
  ) => {
    if (sending.current) return;
    const key = (c: ChatContext, r: string) =>
      `${c}:${c === "recording" ? r : ""}`;
    drafts.current.set(key(context, recordingId), question);
    const saved = drafts.current.get(key(next, id)) ?? "";
    setQuestion(
      prefill
        ? saved && saved !== prefill
          ? `${saved}\n\n${prefill}`
          : prefill
        : saved,
    );
    setContext(next);
    setRecordingId(id);
    setRecordingTitle(title);
  };
  const showImpl = useRef<(intent: AskIntent) => void>(() => {});
  showImpl.current = (intent: AskIntent) => {
    // Reopening a draft retains its explicit scope. Problem shortcuts deliberately select help.
    if (!sending.current && (!question.trim() || intent.question))
      changeContext(
        intent.context,
        intent.recordingId ?? recordingId,
        intent.recordingTitle ?? recordingTitle,
        intent.question,
      );
    setOpen(true);
  };
  const show = useCallback((intent: AskIntent) => showImpl.current(intent), []);
  const newConversation = () => {
    if (sending.current) return;
    void select("");
    setQuestion("");
    drafts.current.clear();
  };
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    void api
      .onAiDelta((e) => {
        if (alive && e.id === active.current) setStream((s) => s + e.text);
      })
      .then((fn) => {
        if (alive) off = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  const send = async (category: string) => {
    if (
      sending.current ||
      !question.trim() ||
      (context === "recording" && !recordingId)
    )
      return;
    sending.current = true;
    setBusy(true);
    setStream("");
    const text = question;
    const scope = context;
    const mediaId = scope === "recording" ? recordingId : "";
    const usesArchive = scope === "archive" || scope === "recording";
    setQuestion("");
    drafts.current.delete(`${scope}:${mediaId}`);
    try {
      let id = active.current;
      if (!id) {
        id = await api.aiCreateChat();
        active.current = id;
        setSelected(id);
        setDetail(await api.aiReadChat(id));
      }
      ++loadSerial.current;
      setDetail(
        (d) =>
          d && {
            ...d,
            messages: [
              ...d.messages,
              {
                id: "pending",
                role: "user",
                context_kind: scope === "recording" ? "archive" : scope,
                context_media_id: mediaId,
                content: text,
                model: "",
                sources: [],
                starred: 0,
                error: 0,
                created_at: "",
              },
            ],
          },
      );
      const result = await api.aiSend({
        conversationId: id,
        text,
        useLibrary: usesArchive,
        context: scope === "recording" ? "archive" : scope,
        semantic,
        filter: {
          ...filter,
          category: mediaId ? "" : category,
          mediaId,
          kind: mediaId ? "recording" : filter.kind,
        },
      });
      setDetail(result);
      await reload();
    } catch (e) {
      toast.error(e);
      setQuestion(text);
      if (active.current)
        try {
          setDetail(await api.aiReadChat(active.current));
        } catch {
          /* Keep the recoverable draft. */
        }
    } finally {
      sending.current = false;
      setBusy(false);
      setStream("");
    }
  };
  const edit = async (options: {
    title?: string;
    pinned?: boolean;
    remove?: boolean;
  }) => {
    if (!selected || sending.current) return;
    try {
      await api.aiEditChat(selected, options);
      if (options.remove) newConversation();
      else setDetail(await api.aiReadChat(selected));
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };
  const star = async (id: string, value: boolean) => {
    try {
      await api.aiStarMessage(id, value);
      const d = await api.aiReadChat(selected);
      if (!sending.current) setDetail(d);
    } catch (e) {
      toast.error(e);
    }
  };
  return {
    open,
    show,
    close,
    config,
    refresh,
    list,
    selected,
    detail,
    question,
    setQuestion,
    context,
    changeContext,
    recordingId,
    recordingTitle,
    semantic,
    setSemantic,
    filter,
    setFilter,
    busy,
    stream,
    select,
    newConversation,
    send,
    edit,
    star,
  };
}
const ChatContextStore = createContext<ReturnType<typeof useChatStore> | null>(
  null,
);
const ShellContext = createContext<Pick<
  ReturnType<typeof useChatStore>,
  "open" | "show" | "close"
> | null>(null);
export function ChatProvider({ children }: { children: ReactNode }) {
  const chat = useChatStore();
  const shell = useMemo(
    () => ({ open: chat.open, show: chat.show, close: chat.close }),
    [chat.open, chat.show, chat.close],
  );
  return (
    <ShellContext.Provider value={shell}>
      <ChatContextStore.Provider value={chat}>
        {children}
      </ChatContextStore.Provider>
    </ShellContext.Provider>
  );
}
export function useChatShell() {
  const value = useContext(ShellContext);
  if (!value) throw Error("Missing ChatProvider");
  return value;
}
export function useChat() {
  const value = useContext(ChatContextStore);
  if (!value) throw Error("Missing ChatProvider");
  return value;
}
