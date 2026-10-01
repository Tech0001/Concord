import { useEffect, useState } from "react";
import { Check, ExternalLink, LoaderCircle, MessageCircle, Search, ShieldCheck } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { ChatGPTSettings } from "../ai/ChatGPTSettings.tsx";
import type { AiConfig, Provider } from "../ai/types.ts";
import type { AutomaticAi } from "../pipeline/types.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { errorMessage, useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { privacyLines } from "./model.ts";
import { SetupFoot, SetupHead } from "./parts.tsx";
import type { StepProps } from "./steps.ts";
import type { ChatChoice, LocalServer, SearchChoice } from "./types.ts";

type Task = "embedding" | "chat";
type Model = { id: string; name: string };
const CHATGPT_URL = "https://api.openai.com/v1";
const OPENROUTER_URL = "https://openrouter.ai/api/v1";
const SERVER_NAME = { ollama: "Ollama", lmstudio: "LM Studio" };

function Choice({ checked, label, hint, badge, ok, onClick }: { checked: boolean; label: string; hint: string; badge?: string; ok?: boolean; onClick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={checked} className="setup-choice" onClick={onClick}>
      <span className="setup-radio" />
      <span className="setup-choice-label">{label}</span>
      {badge && <span className={ok ? "setup-badge is-ok" : "setup-badge"}>{badge}</span>}
      <span className="setup-choice-hint">{hint}</span>
    </button>
  );
}

/** Connects one task to an API provider: saves it, loads its models, and runs a test request. */
function Connect({
  task,
  choice,
  current,
  server,
  onSaved,
}: {
  task: Task;
  choice: Exclude<ChatChoice, "off">;
  current: Provider;
  server?: LocalServer;
  onSaved: (config: AiConfig) => void;
}) {
  const toast = useToast();
  const same = current.kind === choice;
  const cli = choice === "codex" || choice === "claude-code";
  const [baseUrl, setBaseUrl] = useState(
    same && choice !== "openrouter" ? current.baseUrl : choice === "local" ? (server?.baseUrl ?? "http://127.0.0.1:11434/v1") : choice === "custom" ? "" : OPENROUTER_URL,
  );
  const [key, setKey] = useState("");
  const [account, setAccount] = useState(same ? (current.accountId ?? "") : "");
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState(same ? current.model : cli ? "default" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(same && current.enabled && !!current.model && (choice !== "chatgpt" || !!current.connected));
  // A found local server is shown instead of an address field, so test that server.
  const address = choice === "local" && server ? server.baseUrl : baseUrl.trim();
  const provider = (m: string, accountId = account): Provider => ({
    kind: choice,
    baseUrl: cli ? "" : choice === "chatgpt" ? CHATGPT_URL : choice === "openrouter" ? OPENROUTER_URL : address,
    model: m,
    enabled: true,
    accountId,
    hasKey: false,
    local: choice === "local",
  });
  // Test first and save only after a test request succeeds, so a failed try never replaces a
  // working provider or its key.
  const connect = async (chosen = model, accountId = account) => {
    setBusy(true);
    setError("");
    try {
      const tried = await api.aiTryProvider(task, provider(chosen, accountId), key || null);
      setModels(tried.models);
      setModel(tried.model);
      if (tried.error) throw new Error(tried.error);
      const saved = await api.aiSaveProvider(task, provider(tried.model, accountId), key || null);
      setKey("");
      setConnected(true);
      onSaved(saved);
    } catch (e) {
      setConnected(false);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const changeModel = (m: string) => {
    setModel(m);
    void connect(m);
  };
  const test = (
    <Button icon={busy ? LoaderCircle : undefined} disabled={busy || (choice === "custom" && !baseUrl.trim())} onClick={() => void connect()}>
      {busy ? "Testing…" : connected ? "Test again" : "Test"}
    </Button>
  );
  return (
    <div className="setup-connect">
      {cli && <><p>Install and sign in to {choice === "codex" ? "Codex" : "Claude Code"} on this computer using <code>{choice === "codex" ? "codex login" : "claude auth login"}</code>. Concord uses that CLI and its subscription login; no API key is needed.</p><div className="setup-connect-row"><input aria-label="Subscription chat model" value={model} placeholder="default" onChange={e => setModel(e.target.value)} />{test}</div><p>Use default or enter a model available to your account. A test sends a short connection check.</p></>}
      {choice === "chatgpt" && (
        <ChatGPTSettings
          accountId={account}
          onAccount={(id, ready) => {
            setAccount(id);
            if (ready) void connect(model, id);
          }}
        />
      )}
      {choice === "openrouter" && (
        <>
          <span className="setup-connect-label">
            <label htmlFor={`${task}-key`}>OpenRouter API key</label>
            <button type="button" className="text-link" onClick={() => void api.openExternal("https://openrouter.ai/keys").catch(toast.error)}>
              Get a key <ExternalLink size={12} aria-hidden />
            </button>
          </span>
          <div className="setup-connect-row">
            <input
              id={`${task}-key`}
              type="password"
              autoComplete="off"
              placeholder={current.kind === "openrouter" && current.hasKey ? "Saved · leave blank to keep it" : "sk-or-v1-…"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            {test}
          </div>
        </>
      )}
      {choice === "local" && (
        <div className="setup-connect-row">
          {server ? (
            <>
              <code className="setup-path">{server.baseUrl}</code>
              <span className="setup-badge is-ok">{SERVER_NAME[server.kind]} is running</span>
            </>
          ) : (
            <input aria-label="Local server address" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          )}
          <span className="spacer" />
          {test}
        </div>
      )}
      {choice === "local" && !server && <p>Start Ollama or LM Studio on this computer, then test the connection.</p>}
      {choice === "custom" && (
        <>
          <label className="setup-connect-label" htmlFor={`${task}-url`}>
            Address and key
          </label>
          <input id={`${task}-url`} type="url" placeholder="https://example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <div className="setup-connect-row">
            <input type="password" autoComplete="off" aria-label="API key (optional)" placeholder="API key (optional)" value={key} onChange={(e) => setKey(e.target.value)} />
            {test}
          </div>
        </>
      )}
      {error && (
        <p role="alert" className="setup-error">
          {error}
        </p>
      )}
      {(connected || models.length > 0) && (
        <div className="setup-connect-row">
          {connected ? (
            <span className="setup-ok">
              <Check size={15} aria-hidden />
              Connected
            </span>
          ) : (
            <span className="muted">Try another model</span>
          )}
          <span className="spacer" />
          <Select
            size="sm"
            label="Model"
            value={model}
            disabled={busy}
            onChange={changeModel}
            options={(models.length ? models : [{ id: model, name: model }]).map((m) => ({ value: m.id, label: m.name || m.id }))}
          />
        </div>
      )}
    </div>
  );
}

export function AiStep({ status, next, skip, back, detour, chat: preselected }: StepProps) {
  const { refreshSetup } = useApp();
  const toast = useToast();
  const [config, setConfig] = useState<AiConfig>();
  const [servers, setServers] = useState<LocalServer[]>([]);
  const [search, setSearch] = useState<SearchChoice>("builtin");
  const [chat, setChat] = useState<ChatChoice>("off");
  const [automatic, setAutomatic] = useState<AutomaticAi>();
  // Only a search choice made on this visit starts the 639 MB download; opening this step just to
  // connect chat must not.
  const [searchTouched, setSearchTouched] = useState(false);
  useEffect(() => {
    api
      .aiConfig()
      .then((c) => {
        setConfig(c);
        setSearch(c.embedding.enabled ? (c.embedding.kind as SearchChoice) : "off");
        setChat(preselected ?? (c.chat.enabled ? (c.chat.kind as ChatChoice) : "off"));
      })
      .catch(toast.error);
    api.setupProbeLocal().then(setServers).catch(() => setServers([]));
    api.pipelineAiState().then(setAutomatic).catch(() => setAutomatic(undefined));
  }, [preselected, toast]);
  const saved = (c: AiConfig) => {
    setConfig(c);
    void refreshSetup();
  };
  const pickSearch = async (choice: SearchChoice) => {
    setSearch(choice);
    setSearchTouched(true);
    if (!config || (choice !== "builtin" && choice !== "off")) return;
    const provider: Provider =
      choice === "builtin"
        ? { kind: "builtin", enabled: true, baseUrl: "http://127.0.0.1", model: "Qwen3-Embedding-0.6B-Q8_0", hasKey: false, local: true }
        : { ...config.embedding, enabled: false };
    try {
      saved(await api.aiSaveProvider("embedding", provider, null));
    } catch (e) {
      toast.error(e);
    }
  };
  const pickChat = async (choice: ChatChoice) => {
    setChat(choice);
    if (!config || choice !== "off") return;
    try {
      saved(await api.aiSaveProvider("chat", { ...config.chat, enabled: false }, null));
    } catch (e) {
      toast.error(e);
    }
  };
  const chatConnected = !!config?.chat.enabled && !!config.chat.model && chat !== "off";
  const summaries = !!automatic?.summary.enabled;
  const toggleSummaries = async () => {
    if (!automatic) return;
    try {
      setAutomatic(await api.pipelineAiSave(automatic.embedding.enabled, !summaries));
    } catch (e) {
      toast.error(e);
    }
  };
  const proceed = async () => {
    const download = status.search.download.status;
    if ((!detour || searchTouched) && search === "builtin" && !status.search.modelReady && !["waiting", "running"].includes(download)) {
      try {
        await api.aiBuiltinPrepare(status.speech.setup.status === "running");
      } catch (e) {
        toast.error(e);
      }
    }
    next();
  };
  const server = servers[0];
  const [searchLine, chatLine] = privacyLines(search, chat);
  return (
    <>
      <div className="setup-content">
        <SetupHead eyebrow={detour ? "Search & AI" : "Step 4 of 5 · Optional"} title="Search by meaning, and ask questions">
          Two separate features, each with its own provider. Search on this computer and chat through OpenRouter, for example.
        </SetupHead>
        <div className="setup-ai">
          <div className="setup-ai-col">
            <section className="setup-card" aria-labelledby="smart-search">
              <div className="setup-card-head">
                <span className="setup-option-icon">
                  <Search size={17} aria-hidden />
                </span>
                <span>
                  <b id="smart-search">Smart search</b>
                  <small>Finds passages by meaning, not just exact words.</small>
                </span>
              </div>
              <div className="setup-choices" role="radiogroup" aria-labelledby="smart-search">
                <Choice checked={search === "builtin"} label="On this computer" badge="Recommended" hint={status.search.modelReady ? "Downloaded" : "639 MB"} onClick={() => void pickSearch("builtin")} />
                <Choice
                  checked={search === "local"}
                  label="Local server"
                  hint={server ? SERVER_NAME[server.kind] : "Ollama or LM Studio"}
                  badge={server ? "Found" : undefined}
                  ok
                  onClick={() => void pickSearch("local")}
                />
                <Choice checked={search === "openrouter"} label="OpenRouter" hint="Uses your API key" onClick={() => void pickSearch("openrouter")} />
                {config?.embedding.kind === "custom" && <Choice checked={search === "custom"} label="Other" hint="OpenAI-compatible address" onClick={() => void pickSearch("custom")} />}
                <Choice checked={search === "off"} label="Off" hint="Exact words only" onClick={() => void pickSearch("off")} />
              </div>
              {config && (search === "local" || search === "openrouter" || search === "custom") && (
                <Connect key={`embedding-${search}`} task="embedding" choice={search} current={config.embedding} server={server} onSaved={saved} />
              )}
            </section>
            <aside className="setup-privacy" aria-label="What leaves this computer">
              <ShieldCheck size={18} aria-hidden />
              <div>
                <b>What leaves this computer</b>
                <p>{searchLine}</p>
                <p>{chatLine}</p>
                <small>Keys are saved only on this computer, readable only by you.</small>
              </div>
            </aside>
          </div>
          <section className="setup-card" aria-labelledby="ask-archive">
            <div className="setup-card-head">
              <span className="setup-option-icon">
                <MessageCircle size={17} aria-hidden />
              </span>
              <span>
                <b id="ask-archive">Ask your archive</b>
                <small>Answers questions with quotes that jump to the moment.</small>
              </span>
            </div>
            <div className="setup-choices" role="radiogroup" aria-labelledby="ask-archive">
              <Choice checked={chat === "off"} label="Not now" hint="Add it later" onClick={() => void pickChat("off")} />
              <Choice checked={chat === "codex"} label="Codex" hint="Installed CLI · ChatGPT subscription" onClick={() => void pickChat("codex")} />
              <Choice checked={chat === "claude-code"} label="Claude Code" hint="Installed CLI · Claude subscription" onClick={() => void pickChat("claude-code")} />
              <Choice checked={chat === "chatgpt"} label="ChatGPT account" hint="Sign in, uses your plan" onClick={() => void pickChat("chatgpt")} />
              <Choice checked={chat === "openrouter"} label="OpenRouter" hint="API key, many models" onClick={() => void pickChat("openrouter")} />
              <Choice
                checked={chat === "local"}
                label="Local server"
                hint={server ? server.baseUrl.replace(/^https?:\/\//, "").replace(/\/v1$/, "") : "Ollama or LM Studio"}
                badge={server ? "Found" : undefined}
                ok
                onClick={() => void pickChat("local")}
              />
              <Choice checked={chat === "custom"} label="Other" hint="OpenAI-compatible address" onClick={() => void pickChat("custom")} />
            </div>
            {chat === "off" ? (
              <div className="setup-connect">
                <p>Concord works fully without chat. Connect a provider any time in Settings › AI.</p>
              </div>
            ) : (
              config && <Connect key={`chat-${chat}`} task="chat" choice={chat} current={config.chat} server={server} onSaved={saved} />
            )}
            {chatConnected && automatic && (
              <button type="button" role="switch" aria-checked={summaries} className="setup-switch" onClick={() => void toggleSummaries()}>
                <span className="setup-switch-track" />
                Summarize new recordings after they're transcribed
              </button>
            )}
          </section>
        </div>
      </div>
      <SetupFoot back={back} skip={skip} primary={{ label: detour ? "Done" : "Continue", onClick: () => void proceed() }} />
    </>
  );
}
