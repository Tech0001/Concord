import { ChatGPTSettings } from "./ChatGPTSettings.tsx";
import { useEffect, useState } from "react";
import { Check, RefreshCw, Save } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { IndexControl } from "./IndexControl.tsx";
import type { AiConfig, Provider } from "./types.ts";
import "./ai.css";
function ProviderEditor({
  task,
  value,
  onSaved,
}: {
  task: "embedding" | "chat";
  value: Provider;
  onSaved: (c: AiConfig) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [key, setKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const toast = useToast();
  useEffect(() => {
    setDraft(value);
    setKey("");
    setRemoveKey(false);
  }, [
    value.enabled,
    value.kind,
    value.baseUrl,
    value.model,
    value.accountId,
    value.connected,
    value.hasKey,
    value.local,
  ]);
  const builtin = draft.kind === "builtin";
  const cli = draft.kind === "codex" || draft.kind === "claude-code";
  const chatgpt = draft.kind === "chatgpt";
  const changed = (kind: Provider["kind"]) => {
    setDraft({
      ...draft,
      kind,
      baseUrl:
        kind === "codex" || kind === "claude-code" ? "" : kind === "chatgpt"
          ? "https://api.openai.com/v1"
          : kind === "openrouter"
            ? "https://openrouter.ai/api/v1"
            : "http://127.0.0.1:11434/v1",
      model: kind === "codex" || kind === "claude-code" ? "default" : kind === "builtin" ? "Qwen3-Embedding-0.6B-Q8_0" : "",
      enabled: kind === "builtin" || kind === "codex" || kind === "claude-code" || draft.enabled,
      hasKey: false,
      accountId: "",
      connected: false,
    });
    setKey("");
    setRemoveKey(true);
    setModels([]);
    setMessage("");
  };
  const save = async () => {
    const c = await api.aiSaveProvider(
      task,
      draft,
      removeKey ? "" : key || null,
    );
    onSaved(c);
    return c;
  };
  const action = async (what: "save" | "models" | "check") => {
    setBusy(true);
    setMessage("");
    try {
      if (cli && what === "check") {
        const tried = await api.aiTryProvider(task, draft, null);
        if (tried.error) throw new Error(tried.error);
        await save();
        setMessage(tried.message || "Connected");
        return;
      }
      await save();
      if (what === "models") {
        setModels(await api.aiModels(task));
        setMessage("Model list loaded. Choose a model, then save.");
      } else if (what === "check")
        setMessage((await api.aiCheck(task)).message);
      else setMessage("Saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="provider-editor">
      <header>
        <h3>{task === "embedding" ? "Embedding model" : "Chat model"}</h3>
        <p>
          {task === "embedding"
            ? "Finds relevant passages for semantic search and chat. Independent of the chat model."
            : "Writes answers, summaries and suggested tags. Chat stays disabled until you configure it."}
        </p>
      </header>
      <label className="field">
        <span>Provider</span>
        <Select
          label={`${task} provider`}
          value={draft.kind}
          onChange={(v) => changed(v as Provider["kind"])}
          options={[
            ...(task === "embedding"
              ? [
                  {
                    value: "builtin",
                    label: "Built-in local · Qwen3 Embedding (recommended)",
                  },
                ]
              : []),
            ...(task === "chat"
              ? [
                  { value: "codex", label: "Codex CLI · ChatGPT subscription" },
                  { value: "claude-code", label: "Claude Code CLI · Claude subscription" },
                  {
                    value: "chatgpt",
                    label: "ChatGPT · sign in with your account",
                  },
                ]
              : []),
            { value: "local", label: "Local server · Ollama / LM Studio" },
            { value: "openrouter", label: "OpenRouter" },
            { value: "custom", label: "Custom OpenAI-compatible server" },
          ]}
        />
      </label>
      {builtin ? (
        <p className="settings-note">
          Uses your GPU automatically when supported; otherwise runs on CPU.
          No API key or separate AI application needed. The index below shows the active device.
        </p>
      ) : (
        <>
          {cli && <p className="settings-note">Uses your installed, signed-in {draft.kind === "codex" ? "Codex" : "Claude Code"}. Sign in with <code>{draft.kind === "codex" ? "codex login" : "claude auth login"}</code>, then Test connection. Use <code>default</code> for its default model, or enter a model available to your account. Concord does not store your subscription credentials.</p>}
          {chatgpt && (
            <ChatGPTSettings
              accountId={draft.accountId || ""}
              onAccount={(id, ready) =>
                setDraft((old) => ({
                  ...old,
                  accountId: id,
                  model: old.accountId === id ? old.model : "",
                  enabled: ready,
                  connected: ready,
                }))
              }
            />
          )}
          <label className="check-label">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft((old) => ({ ...old, enabled: e.target.checked }))
              }
            />{" "}
            Enable {task === "embedding" ? "this embedding provider" : "chat"}
          </label>
          {!chatgpt && !cli && (
            <>
              <label className="field">
                <span>API base URL</span>
                <input
                  aria-label={`${task} API base URL`}
                  value={draft.baseUrl}
                  readOnly={draft.kind === "openrouter"}
                  onChange={(e) =>
                    setDraft((old) => ({ ...old, baseUrl: e.target.value }))
                  }
                />
              </label>
              <label className="field">
                <span>
                  API key{" "}
                  {value.hasKey && draft.kind === value.kind && "· saved"}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  aria-label={`${task} API key`}
                  placeholder={
                    value.hasKey
                      ? "Leave blank to keep saved key"
                      : "Optional for local servers"
                  }
                  value={key}
                  onChange={(e) => {
                    setKey(e.target.value);
                    setRemoveKey(false);
                  }}
                />
              </label>
              {value.hasKey && (
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={removeKey}
                    onChange={(e) => {
                      setRemoveKey(e.target.checked);
                      setKey("");
                    }}
                  />{" "}
                  Remove saved key
                </label>
              )}
            </>
          )}
          <label className="field">
            <span>Model</span>
            <input
              aria-label={`${task} model`}
              list={`${task}-models`}
              value={draft.model}
              placeholder={
                task === "embedding"
                  ? "An embedding model, such as qwen3-embedding:0.6b"
                  : "Choose or enter a chat model ID"
              }
              onChange={(e) =>
                setDraft((old) => ({ ...old, model: e.target.value }))
              }
            />
            <datalist id={`${task}-models`}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </datalist>
          </label>
          <p className="settings-note">
            {cli ? "Messages and selected archive excerpts go through the CLI to its provider. Subscription limits and extra-usage settings apply. Embeddings stay with your separate search provider." : chatgpt
              ? "Model choices come from the selected ChatGPT account. Requests use that account’s plan or credits."
              : draft.kind === "local"
                ? "Requests go to a server on this computer."
                : task === "embedding"
                  ? "Indexing sends passages to this provider. Semantic searches send the query; the vector index stays on this computer."
                  : "Chat sends your messages and selected library excerpts to this provider. Summaries send transcript text. Provider usage may incur charges."}
          </p>
        </>
      )}
      <div className="ai-actions">
        <Button icon={Save} disabled={busy} onClick={() => void action("save")}>
          Save {task} settings
        </Button>
        {!builtin && (
          <>
            <Button
              icon={RefreshCw}
              disabled={busy}
              onClick={() => void action("models")}
            >
              Load models
            </Button>
            <Button
              icon={Check}
              disabled={
                busy ||
                !draft.enabled ||
                !draft.model ||
                (chatgpt && !draft.connected)
              }
              onClick={() => void action("check")}
            >
              Test {task}
            </Button>
          </>
        )}
        {message && <small role="status">{message}</small>}
      </div>
    </div>
  );
}
export function ProviderSettings() {
  const [config, setConfig] = useState<AiConfig>();
  const [clear, setClear] = useState(false);
  const toast = useToast();
  useEffect(() => {
    api.aiConfig().then(setConfig).catch(toast.error);
  }, [toast]);
  return (
    <section className="ai-settings">
      <h2>AI providers</h2>
      <p className="muted">
        Embeddings and chat have separate providers, models and credentials. API
        keys are stored in a private file on this computer, outside the library
        database.
      </p>
      {config && (
        <>
          <ProviderEditor
            task="embedding"
            value={config.embedding}
            onSaved={setConfig}
          />
          <ProviderEditor task="chat" value={config.chat} onSaved={setConfig} />
        </>
      )}
      <IndexControl />
      <Button variant="ghost" size="sm" onClick={() => setClear(true)}>
        Clear current model's search index…
      </Button>
      <ConfirmDialog
        open={clear}
        onOpenChange={setClear}
        title="Clear search index?"
        body="This removes only the current embedding model's vectors. Your recordings, documents, notes and chats are kept. Update index to rebuild it."
        confirmLabel="Clear index"
        onConfirm={async () => {
          try {
            await api.aiClearIndex();
            setClear(false);
            toast.success("Search index cleared");
          } catch (e) {
            toast.error(e);
          }
        }}
      />
    </section>
  );
}
