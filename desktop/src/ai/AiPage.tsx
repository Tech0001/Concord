import { HelpContext } from "./ConcordHelp.tsx";
import { HELP_LINKS, PENDING_HELP } from "./help-links.ts";
import { ChatGPTUsage } from "./ChatGPTSettings.tsx";
import { useEffect, useRef, useState } from "react";
import {
  Copy,
  MessageCircle,
  Plus,
  Send,
  Settings2,
  Square,
  Star,
  Trash2,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { COARSE, useMediaQuery } from "../lib/media-query.ts";
import { copyText } from "../lib/clipboard.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Empty } from "../ui/Empty.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { Markdown } from "../documents/Markdown.tsx";
import { IndexControl } from "./IndexControl.tsx";
import { SearchFilters, SearchPanel, SourceHit } from "./SearchPanel.tsx";
import {
  chatReady,
  EMPTY_FILTER,
  type ChatContext,
  type AiConfig,
  type ChatDetail,
  type Conversation,
  type SearchFilter,
} from "./types.ts";
import "./ai.css";
import "../setup/setup.css";
import type { ChatChoice, LocalServer } from "../setup/types.ts";

/** Chat isn't connected: offer the common ways to connect, each opening that part of setup. */
function ConnectChat() {
  const { navigate } = useApp();
  const [servers, setServers] = useState<LocalServer[]>([]);
  useEffect(() => {
    api.setupProbeLocal().then(setServers).catch(() => setServers([]));
  }, []);
  const go = (chat: ChatChoice) => navigate({ page: "setup", step: "ai", returnTo: "ai", chat });
  const server = servers[0];
  return (
    <Empty
      icon={MessageCircle}
      title="Connect chat"
      text="Ask about your recordings, get help setting up Concord, or have a general conversation. Choose what to share with each message."
      action={
        <div className="setup-connect-options">
          <Button onClick={() => go("codex")}>Use Codex<small>ChatGPT subscription</small></Button>
          <Button onClick={() => go("claude-code")}>Use Claude Code<small>Claude subscription</small></Button>
          <Button onClick={() => go("chatgpt")}>
            Sign in with ChatGPT<small>Uses your plan</small>
          </Button>
          <Button onClick={() => go("openrouter")}>
            Use an OpenRouter key<small>Many models</small>
          </Button>
          <Button onClick={() => go("local")}>
            Use a local server
            {server ? <span className="setup-badge is-ok">{server.kind === "lmstudio" ? "LM Studio" : "Ollama"} found</span> : <small>Ollama or LM Studio</small>}
          </Button>
          <button type="button" className="text-link" onClick={() => navigate({ page: "settings", section: "ai" })}>
            More options in Settings › AI
          </button>
        </div>
      }
    />
  );
}
function Chat({ config, initialContext, initialQuestion }: { config: AiConfig; initialContext?: ChatContext; initialQuestion?: string }) {
  const { openNote, category, navigate, openActivity } = useApp();
  const appLinks = Object.fromEntries(Object.entries(HELP_LINKS).map(([href,route])=>[href,()=>route === "health" ? openActivity() : navigate(route)]));
  const toast = useToast();
  const [list, setList] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState(() => sessionStorage.getItem("concord.activeChat") ?? "");
  const [detail, setDetail] = useState<ChatDetail>();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [remove, setRemove] = useState(false);
  const [context, setContext] = useState<ChatContext>(initialContext ?? "archive");
  const useLibrary = context === "archive";
  const touchKeyboard = useMediaQuery(COARSE);
  const received = useRef<string | undefined>(undefined);
  const [semantic, setSemantic] = useState(true);
  const [filter, setFilter] = useState<SearchFilter>({ ...EMPTY_FILTER });
  const [onlyStarred, setOnlyStarred] = useState(false);
  const current = useRef("");
  const reload = () => api.aiConversations().then(rows => {
    setList(rows);
    setSelected(id => id === selected && id && !rows.some(row => row.id === id) ? "" : id);
  }).catch(toast.error);
  useEffect(() => {
    if (selected) sessionStorage.setItem("concord.activeChat", selected);
    else sessionStorage.removeItem("concord.activeChat");
  }, [selected]);
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    let active = true;
    current.current = selected;
    setStream("");
    setDetail(undefined);
    if (selected)
      api
        .aiReadChat(selected)
        .then((d) => {
          if (active) {
            setDetail(d);
            setDraftTitle(d.conversation.title);
          }
        })
        .catch(toast.error);
    return () => {
      active = false;
    };
  }, [selected, toast]);
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    api
      .onAiDelta((event) => {
        if (active && event.id === current.current)
          setStream((s) => s + event.text);
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(toast.error);
    return () => {
      active = false;
      unlisten?.();
    };
  }, [toast]);
  const create = async () => {
    try {
      const id = await api.aiCreateChat();
      setSelected(id);
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };
  useEffect(() => {
    if (busy || !initialQuestion || received.current === initialQuestion) return;
    received.current = initialQuestion;
    setQuestion(initialQuestion); setContext(initialContext ?? "help");
    sessionStorage.removeItem(PENDING_HELP);
    navigate({page:"ai"}, {replace:true});
    if (!selected) void create();
  }, [initialQuestion, initialContext, busy]);
  const send = async () => {
    if (!selected || !question.trim()) return;
    const text = question;
    setBusy(true);
    setStream("");
    setQuestion("");
    setDetail(
      (d) =>
        d && {
          ...d,
          messages: [
            ...d.messages,
            {
              id: "pending",
              role: "user",
              context_kind: context,
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
    try {
      const d = await api.aiSend({
        conversationId: selected,
        text,
        useLibrary,
        context,
        semantic,
        filter: { ...filter, category },
      });
      setDetail(d);
      setDraftTitle(d.conversation.title);
      await reload();
    } catch (e) {
      toast.error(e);
      setQuestion(text);
      api.aiReadChat(selected).then(setDetail).catch(toast.error);
    } finally {
      setBusy(false);
      setStream("");
    }
  };
  const edit = async (options: {
    title?: string;
    pinned?: boolean;
    remove?: boolean;
  }) => {
    try {
      await api.aiEditChat(selected, options);
      if (options.remove) {
        setSelected("");
        setRemove(false);
      } else setDetail(await api.aiReadChat(selected));
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="chat-layout">
      <aside className="chat-history">
        <Button icon={Plus} disabled={busy} onClick={() => void create()}>
          New conversation
        </Button>
        <nav aria-label="Saved conversations">
          {list.map((c) => (
            <button
              key={c.id}
              disabled={busy}
              className={c.id === selected ? "is-active" : ""}
              onClick={() => setSelected(c.id)}
            >
              {!!c.pinned && <Star size={12} />}
              <span>{c.title}</span>
              <small>{c.messages}</small>
            </button>
          ))}
        </nav>
      </aside>
      <section className="chat-main">
        {!selected ? (
          <Empty
            icon={MessageCircle}
            title="Ask your library"
            text="Use one conversation for research, help with Concord, or general questions. Choose what to include with each message."
            action={
              <Button variant="primary" onClick={() => void create()}>
                New conversation
              </Button>
            }
          />
        ) : (
          <>
            <div className="chat-heading">
              <input
                aria-label="Conversation title"
                value={draftTitle}
                disabled={busy}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={() => {
                  if (
                    detail &&
                    draftTitle.trim() &&
                    draftTitle !== detail.conversation.title
                  )
                    void edit({ title: draftTitle });
                }}
              />
              <IconButton
                icon={Star}
                label="Pin conversation"
                active={!!detail?.conversation.pinned}
                disabled={busy}
                onClick={() =>
                  void edit({ pinned: !detail?.conversation.pinned })
                }
              />
              <IconButton
                icon={Trash2}
                label="Delete conversation"
                disabled={busy}
                onClick={() => setRemove(true)}
              />
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={onlyStarred}
                onChange={(e) => setOnlyStarred(e.target.checked)}
              />{" "}
              Starred messages only
            </label>
            <div className="chat-messages" aria-label="Conversation messages">
              {detail?.messages
                .filter((m) => !onlyStarred || m.starred)
                .map((m) => (
                  <article
                    key={m.id}
                    className={`chat-message is-${m.role}${m.error ? " is-error" : ""}`}
                  >
                    <header>
                      <strong>
                        {m.role === "user" ? "You" : "Concord AI"}
                      </strong>
                      {m.model && <small>{m.model}</small>}
                      <small>{m.context_kind === "help" ? "Concord help" : m.context_kind === "none" ? "Neither" : "My archive"}</small>
                    </header>
                    <Markdown source={m.content} appLinks={m.context_kind === "help" ? appLinks : undefined} />
                    {m.id !== "pending" && (
                      <div className="ai-actions">
                        <IconButton
                          size="sm"
                          icon={Star}
                          label="Star message"
                          active={!!m.starred}
                          onClick={() =>
                            api
                              .aiStarMessage(m.id, !m.starred)
                              .then(() => api.aiReadChat(selected))
                              .then(setDetail)
                              .catch(toast.error)
                          }
                        />
                        <IconButton
                          size="sm"
                          icon={Copy}
                          label="Copy message"
                          onClick={() =>
                            copyText(m.content)
                              .then(() => toast.success("Copied"))
                              .catch(toast.error)
                          }
                        />
                        {m.role === "assistant" && !m.error && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              openNote({
                                title: detail.conversation.title,
                                body: m.content,
                                anchors: m.sources
                                  .filter((h) => h.kind !== "note")
                                  .map((h) => ({
                                    ...(h.kind === "recording"
                                      ? {
                                          media_id: h.id,
                                          start: h.start ?? 0,
                                          end: h.end,
                                        }
                                      : { doc_id: h.id }),
                                    quote: h.text,
                                  })),
                              })
                            }
                          >
                            Save as note
                          </Button>
                        )}
                      </div>
                    )}
                    {!!m.sources.length && (
                      <details className="chat-sources">
                        <summary>
                          {m.sources.length} source passages · citations refer
                          to these numbers
                        </summary>
                        {m.sources.map((h, i) => (
                          <SourceHit key={i} hit={h} number={i + 1} />
                        ))}
                      </details>
                    )}
                  </article>
                ))}
              {busy && (
                <article
                  className="chat-message is-assistant"
                  aria-live="polite"
                >
                  <strong>Concord AI</strong>
                  <Markdown appLinks={context === "help" ? appLinks : undefined}
                    source={
                      stream || (context === "help" ? "Checking app status and preparing guidance…" : useLibrary ? "Finding sources and preparing a response…" : "Preparing a response…")
                    }
                  />
                </article>
              )}
            </div>
            <form
              className="chat-composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <div className="ai-actions">
                <fieldset className="chat-context-picker" disabled={busy}>
                  <legend>What to use for this message</legend>
                  {([['archive','My archive'],['help','Concord help'],['none','Neither']] as const).map(([value,label])=><label key={value}><input type="radio" name="chat-context" value={value} checked={context===value} onChange={()=>setContext(value)} />{label}</label>)}
                </fieldset>
                {useLibrary && (
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={semantic}
                      disabled={busy}
                      onChange={(e) => setSemantic(e.target.checked)}
                    />{" "}
                    Find sources by meaning
                  </label>
                )}
              </div>
              {context === "help" && <HelpContext />}
              <small className="muted">History stays together here. The AI receives earlier messages with the same context choice.</small>
              {useLibrary && (
                <SearchFilters filter={filter} onChange={setFilter} />
              )}
              <textarea
                aria-label="Message"
                placeholder="Ask a question…"
                value={question}
                disabled={busy}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !touchKeyboard && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
                    e.preventDefault();
                    if (!busy) e.currentTarget.form?.requestSubmit();
                  }
                }}
                rows={3}
              />
              {!touchKeyboard && <small className="muted">Enter to send · Shift+Enter for a new line</small>}
              <div className="ai-actions">
                <small className="muted">
                  {config.chat.local
                    ? "Chat runs on this computer."
                    : `Messages${useLibrary ? " and matching excerpts" : context === "help" ? ", setup status and error categories" : ""} go to ${config.chat.kind === "openrouter" ? "OpenRouter" : config.chat.kind === "chatgpt" ? "OpenAI" : "your chat provider"}.`}
                </small>
                {config.chat.kind === "chatgpt" && <ChatGPTUsage/>}
                {busy ? (
                  <Button
                    icon={Square}
                    onClick={() =>
                      api.aiCancelChat(selected).catch(toast.error)
                    }
                  >
                    Stop response
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="primary"
                    icon={Send}
                    disabled={!question.trim()}
                  >
                    Send
                  </Button>
                )}
              </div>
            </form>
          </>
        )}
      </section>
      <ConfirmDialog
        open={remove}
        onOpenChange={setRemove}
        title="Delete conversation?"
        body="This deletes the saved chat and its messages. Notes saved from it are kept."
        confirmLabel="Delete conversation"
        onConfirm={() => void edit({ remove: true })}
      />
    </div>
  );
}
export function AiPage() {
  const { navigate, route } = useApp();
  const toast = useToast();
  const [config, setConfig] = useState<AiConfig>();
  const intent = route.page === "ai" ? route : undefined;
  const initialQuestion = intent?.question || sessionStorage.getItem(PENDING_HELP) || undefined;
  const [tab, setTab] = useState<"semantic" | "chat">(intent?.context || initialQuestion ? "chat" : "semantic");
  useEffect(()=>{if(intent?.context || initialQuestion)setTab("chat");},[intent?.context,initialQuestion]);
  useEffect(() => {
    api.aiConfig().then(setConfig).catch(toast.error);
  }, [toast]);
  const ready = chatReady(config?.chat);
  return (
    <div className="ai-page">
      <PageHeader
        title="AI"
        actions={
          <Button
            icon={Settings2}
            onClick={() => navigate({ page: "settings", section: "ai" })}
          >
            AI settings
          </Button>
        }
      />
      <div className="ai-tabs" role="tablist" aria-label="AI tools">
        <button
          role="tab"
          aria-selected={tab === "semantic"}
          onClick={() => setTab("semantic")}
        >
          Semantic search
        </button>
        <button
          role="tab"
          aria-selected={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          Chat
        </button>
      </div>
      {!ready && tab === "semantic" && (
        <p className="ai-setup-hint">
          Semantic search works on this computer.{" "}
          <button className="text-link" onClick={() => setTab("chat")}>
            Connect a chat provider
          </button>{" "}
          to ask questions too.
        </p>
      )}
      {tab === "semantic" ? (
        <>
          <IndexControl />
          <SearchPanel semantic />
        </>
      ) : !ready ? (
        config && <ConnectChat />
      ) : (
        config && <Chat config={config} initialContext={intent?.context ?? (initialQuestion ? "help" : undefined)} initialQuestion={initialQuestion} />
      )}
    </div>
  );
}
