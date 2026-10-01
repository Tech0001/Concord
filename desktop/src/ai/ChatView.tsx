import { useEffect, useRef, useState } from "react";
import {
  Copy,
  MessageCircle,
  MoreHorizontal,
  Plus,
  Send,
  Settings2,
  SlidersHorizontal,
  Square,
  Star,
  Trash2,
  Pencil,
  History,
} from "lucide-react";
import { useChat } from "./ChatStore.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Menu, Panel } from "../ui/Menu.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { Markdown } from "../documents/Markdown.tsx";
import { SearchFilters, SourceHit } from "./SearchPanel.tsx";
import { HelpContext } from "./ConcordHelp.tsx";
import { HELP_LINKS } from "./help-links.ts";
import { ConnectChat } from "./ConnectChat.tsx";
import { chatReady, type ChatContext } from "./types.ts";
import { Citation } from "./Citation.tsx";
import { citedNumbers } from "./citations.ts";
import { api } from "../lib/ipc.ts";
import { copyText } from "../lib/clipboard.ts";
import { COARSE, useMediaQuery } from "../lib/media-query.ts";
import { useToast } from "../ui/Toasts.tsx";
import "./ai.css";
import "../setup/setup.css";
const LABELS: Record<ChatContext, string> = {
  archive: "My archive",
  recording: "This recording",
  help: "Concord help",
  none: "Just chat",
};
export function ChatView({ compact = false }: { compact?: boolean }) {
  const chat = useChat();
  const { navigate, openActivity, openNote, category } = useApp();
  const toast = useToast();
  const [history, setHistory] = useState(
      !compact && !window.matchMedia("(max-width:899px)").matches,
    ),
    [onlyStarred, setOnlyStarred] = useState(false),
    [filters, setFilters] = useState(false),
    [remove, setRemove] = useState(false),
    [rename, setRename] = useState(false),
    [title, setTitle] = useState("");
  const touch = useMediaQuery(COARSE);
  const messages = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    follow = useRef(true);
  useEffect(() => {
    void chat.refresh();
    input.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (follow.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [chat.detail, chat.stream]);
  const links = Object.fromEntries(
    Object.entries(HELP_LINKS).map(([href, route]) => [
      href,
      () => {
        chat.close();
        route === "health" ? openActivity() : navigate(route);
      },
    ]),
  );
  const usesArchive =
    chat.context === "archive" || chat.context === "recording";
  const provider = chat.config?.chat;
  const providerName =
    provider?.kind === "codex"
      ? "Codex"
      : provider?.kind === "claude-code"
        ? "Claude Code"
        : provider?.kind === "chatgpt"
          ? "ChatGPT"
          : provider?.kind === "openrouter"
            ? "OpenRouter"
            : provider?.local
              ? "Local"
              : "Custom provider";
  const model =
    provider?.model === "default" ? "Account default" : provider?.model;
  const modeLabel = (kind: ChatContext | undefined, media?: string) =>
    media ? LABELS.recording : LABELS[kind ?? "archive"];
  const setMode = (mode: ChatContext) => {
    chat.changeContext(mode);
    follow.current = true;
  };
  if (!chat.config) return <p className="muted">Loading chat…</p>;
  if (!chatReady(provider)) return <ConnectChat />;
  return (
    <div className={`chat-workspace ${compact ? "is-compact" : ""}`}>
      {history && (
        <aside className="chat-history" aria-label="Conversation history">
          <Button variant="ghost" onClick={() => setHistory(false)}>
            Back to chat
          </Button>
          <Button
            icon={Plus}
            disabled={chat.busy}
            onClick={() => {
              chat.newConversation();
              if (compact) setHistory(false);
            }}
          >
            New conversation
          </Button>
          <label className="check-label">
            <input
              type="checkbox"
              checked={onlyStarred}
              onChange={(e) => setOnlyStarred(e.target.checked)}
            />
            Starred conversations
          </label>
          <nav aria-label="Saved conversations">
            {chat.list
              .filter((c) => !onlyStarred || c.pinned)
              .map((c) => (
                <button
                  key={c.id}
                  disabled={chat.busy}
                  className={c.id === chat.selected ? "is-active" : ""}
                  onClick={() => {
                    void chat.select(c.id);
                    follow.current = true;
                    if (compact) setHistory(false);
                  }}
                >
                  {!!c.pinned && <Star size={12} />}
                  <span>{c.title}</span>
                  <small>{c.messages}</small>
                </button>
              ))}
          </nav>
        </aside>
      )}
      <section className="chat-thread">
        <header className="chat-heading">
          <IconButton
            icon={History}
            label="Conversation history"
            active={history}
            onClick={() => setHistory((v) => !v)}
          />
          <h2>{chat.detail?.conversation.title ?? "Ask Concord"}</h2>
          <IconButton
            icon={Plus}
            label="New conversation"
            disabled={chat.busy}
            onClick={() => {
              chat.newConversation();
              follow.current = true;
            }}
          />
          <Menu
            label="Conversation options"
            trigger={
              <IconButton icon={MoreHorizontal} label="Conversation options" />
            }
            entries={[
              {
                label: "Rename conversation",
                icon: Pencil,
                disabled: !chat.selected || chat.busy,
                onSelect: () => {
                  setTitle(chat.detail?.conversation.title ?? "");
                  setRename(true);
                },
              },
              {
                label: chat.detail?.conversation.pinned
                  ? "Unstar conversation"
                  : "Star conversation",
                icon: Star,
                disabled: !chat.selected || chat.busy,
                onSelect: () =>
                  void chat.edit({ pinned: !chat.detail?.conversation.pinned }),
              },
              {
                label: "AI settings",
                icon: Settings2,
                onSelect: () => {
                  chat.close();
                  navigate({ page: "settings", section: "ai" });
                },
              },
              { kind: "separator" },
              {
                label: "Delete conversation",
                icon: Trash2,
                danger: true,
                disabled: !chat.selected || chat.busy,
                onSelect: () => setRemove(true),
              },
            ]}
          />
        </header>
        <div
          ref={messages}
          className="chat-messages"
          aria-label="Conversation messages"
          onScroll={(e) => {
            const n = e.currentTarget;
            follow.current = n.scrollHeight - n.scrollTop - n.clientHeight < 80;
          }}
        >
          {!chat.detail?.messages.length && !chat.busy && (
            <div className="chat-welcome">
              <MessageCircle size={28} />
              <h3>What would you like to know?</h3>
              <p>
                Ask about your archive, the recording you’re watching, or how to
                set up Concord.
              </p>
              <p className="muted">
                Choose what to use below. Nothing is sent until you press Send.
              </p>
            </div>
          )}
          {chat.detail?.messages.map((m) => {
            const cited = citedNumbers(m.content, m.sources.length);
            return (
              <article
                key={m.id}
                className={`chat-message is-${m.role}${m.error ? " is-error" : ""}`}
              >
                <header>
                  <strong>{m.role === "user" ? "You" : "Concord"}</strong>
                  <small>{modeLabel(m.context_kind, m.context_media_id)}</small>
                </header>
                {m.context_status && (
                  <p className="chat-status-line">{m.context_status}</p>
                )}
                <Markdown
                  source={m.content}
                  appLinks={m.context_kind === "help" ? links : undefined}
                  citation={(n) =>
                    m.sources[n - 1] ? (
                      <Citation
                        number={n}
                        hit={m.sources[n - 1]}
                        onNavigate={chat.close}
                      />
                    ) : (
                      `[${n}]`
                    )
                  }
                />
                {m.id !== "pending" && (
                  <div className="chat-message-actions">
                    <IconButton
                      size="sm"
                      icon={Copy}
                      label="Copy message"
                      onClick={() =>
                        void copyText(m.content)
                          .then(() => toast.success("Copied"))
                          .catch(toast.error)
                      }
                    />
                    <IconButton
                      size="sm"
                      icon={Star}
                      label="Star message"
                      active={!!m.starred}
                      disabled={chat.busy}
                      onClick={() => void chat.star(m.id, !m.starred)}
                    />
                    {m.role === "assistant" && !m.error && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          openNote({
                            title: chat.detail!.conversation.title,
                            body: m.content,
                            anchors: cited
                              .map((n) => m.sources[n - 1])
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
                {!!cited.length && (
                  <details className="chat-sources">
                    <summary>
                      {cited.length} cited{" "}
                      {cited.length === 1 ? "passage" : "passages"}
                    </summary>
                    {cited.map((n) => (
                      <SourceHit
                        key={n}
                        hit={m.sources[n - 1]}
                        number={n}
                        onNavigate={chat.close}
                      />
                    ))}
                  </details>
                )}
                {m.role === "assistant" && !m.error && !!m.sources.length && (
                  <small className="chat-sent-count">
                    {m.sources.length} matching passages sent · {cited.length}{" "}
                    cited
                  </small>
                )}
              </article>
            );
          })}
          {chat.busy && (
            <article className="chat-message is-assistant" aria-live="polite">
              <strong>Concord</strong>
              <Markdown
                source={chat.stream || "Preparing your answer…"}
                appLinks={chat.context === "help" ? links : undefined}
              />
            </article>
          )}
        </div>
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            follow.current = true;
            void chat.send(category);
          }}
        >
          <fieldset className="chat-context-picker" disabled={chat.busy}>
            <legend>What to use</legend>
            {(Object.keys(LABELS) as ChatContext[]).map((value) => (
              <label
                key={value}
                className={chat.context === value ? "is-selected" : ""}
                title={
                  value === "recording" && !chat.recordingId
                    ? "Open a recording, then choose Ask"
                    : undefined
                }
              >
                <input
                  type="radio"
                  name="chat-context"
                  value={value}
                  disabled={value === "recording" && !chat.recordingId}
                  checked={chat.context === value}
                  onChange={() => setMode(value)}
                />
                {LABELS[value]}
              </label>
            ))}
          </fieldset>
          {chat.context === "recording" && (
            <small className="chat-recording-scope">
              {chat.recordingTitle || "Only the selected recording"}
            </small>
          )}
          {chat.context === "help" && <HelpContext />}
          <textarea
            ref={input}
            aria-label="Message"
            placeholder={
              chat.context === "help"
                ? "What would you like help setting up?"
                : "Ask a question…"
            }
            value={chat.question}
            disabled={chat.busy}
            rows={3}
            onChange={(e) => chat.setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !touch &&
                !e.nativeEvent.isComposing &&
                e.nativeEvent.keyCode !== 229
              ) {
                e.preventDefault();
                if (!chat.busy) e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="chat-composer-tools">
            {usesArchive && (
              <Panel
                title="Source filters"
                open={filters}
                onOpenChange={setFilters}
                trigger={
                  <Button size="sm" variant="ghost" icon={SlidersHorizontal}>
                    Filters
                  </Button>
                }
              >
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={chat.semantic}
                    disabled={chat.busy}
                    onChange={(e) => chat.setSemantic(e.target.checked)}
                  />
                  Find sources by meaning
                </label>
                <SearchFilters filter={chat.filter} onChange={chat.setFilter} />
              </Panel>
            )}
            <span
              className="chat-provider"
              title={`${providerName} · ${model}`}
            >
              {providerName} · {model}
            </span>
            {chat.busy ? (
              <Button
                size="sm"
                icon={Square}
                onClick={() =>
                  void api.aiCancelChat(chat.selected).catch(toast.error)
                }
              >
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                size="sm"
                icon={Send}
                disabled={
                  !chat.question.trim() ||
                  (chat.context === "recording" && !chat.recordingId)
                }
              >
                Send
              </Button>
            )}
          </div>
          <div className="chat-privacy">
            <small>
              {provider?.local
                ? "Stays on this computer"
                : "Sent to " + providerName}
              : your question +{" "}
              {usesArchive
                ? "matching passages (up to 10)"
                : chat.context === "help"
                  ? "setup status and error categories"
                  : "no archive or app data"}
              . Earlier messages from the same scope are included.
            </small>
            {!touch && (
              <small>Enter to send · Shift+Enter for a new line</small>
            )}
          </div>
        </form>
      </section>
      <ConfirmDialog
        open={remove}
        onOpenChange={setRemove}
        title="Delete conversation?"
        body="Saved notes are kept."
        confirmLabel="Delete conversation"
        danger
        onConfirm={() => void chat.edit({ remove: true })}
      />
      <Dialog
        open={rename}
        onOpenChange={setRename}
        title="Rename conversation"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRename(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!title.trim()}
              onClick={() => {
                void chat.edit({ title });
                setRename(false);
              }}
            >
              Save name
            </Button>
          </>
        }
      >
        <label className="field">
          Conversation title
          <input
            aria-label="Conversation title"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
      </Dialog>
    </div>
  );
}
