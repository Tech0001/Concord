import { useEffect, useState } from "react";
import {
  Clock,
  LoaderCircle,
  RefreshCw,
  Save,
  Sparkles,
  Square,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Switch } from "../ui/Switch.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { AiTarget, AutomaticAi } from "./types.ts";

function destination(t: AiTarget) {
  return `${t.model || "No model selected"} · ${
    t.kind === "builtin"
      ? "Built-in, on this computer"
      : t.kind === "codex"
        ? "Codex CLI"
        : t.kind === "claude-code"
          ? "Claude Code CLI"
          : t.kind === "chatgpt"
            ? "ChatGPT plan"
            : t.kind === "openrouter"
              ? "OpenRouter"
              : t.baseUrl
  }`;
}

export function AutomaticSetup({
  state,
  onChanged,
}: {
  state: AutomaticAi;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [embedding, setEmbedding] = useState(state.embedding.enabled);
  const [summary, setSummary] = useState(state.summary.enabled);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!dirty) {
      setEmbedding(state.embedding.enabled);
      setSummary(state.summary.enabled);
    }
  }, [dirty, state.embedding.enabled, state.summary.enabled]);

  const save = async () => {
    setBusy(true);
    try {
      await api.pipelineAiSave(embedding, summary);
      await onChanged();
      setDirty(false);
      toast.success("After-transcription actions saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section" aria-label="After transcription">
      <header>
        <span className="settings-icon">
          <Sparkles size={17} aria-hidden />
        </span>
        <h2>After transcription</h2>
      </header>
      <div className="settings-body">
        <p className="settings-note">
          Optional actions for newly finished recordings. They run separately
          from speech processing, so your transcript stays safe if an AI call
          fails.
        </p>
        {(
          [
            [
              "embedding",
              "Add new recordings to semantic search",
              embedding,
              setEmbedding,
            ],
            [
              "summary",
              "Generate a summary automatically",
              summary,
              setSummary,
            ],
          ] as const
        ).map(([key, label, checked, change]) => (
          <div className="automatic-option" key={key}>
            <Switch
              checked={checked}
              disabled={busy || (!state[key].ready && !checked)}
              onChange={(next) => {
                change(next);
                setDirty(true);
              }}
              hint={`${destination(state[key].current)} · ${
                state[key].local
                  ? "Stays on this computer."
                  : "Sends transcript text to this provider."
              }`}
            >
              {label}
            </Switch>
            {!state[key].ready && (
              <p className="settings-note">
                Configure and enable this provider above first.
              </p>
            )}
            {state[key].needsReview && (
              <p className="automatic-review">
                The model or provider changed. Save below to approve it for
                future recordings.
              </p>
            )}
          </div>
        ))}
        <p className="settings-note">
          Existing recordings are not backfilled automatically — use Build /
          Update search index above for your existing archive.
        </p>
        <div className="automatic-actions">
          <Button
            variant={dirty ? "primary" : "secondary"}
            icon={Save}
            disabled={busy || (!dirty && !state.embedding.needsReview && !state.summary.needsReview)}
            onClick={() => void save()}
          >
            Save automatic actions
          </Button>
        </div>
      </div>
    </section>
  );
}

const labels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  complete: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  blocked: "Approval needed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

export function AutomaticQueue({
  state,
  onChanged,
}: {
  state: AutomaticAi;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = state.jobs.filter((j) =>
    ["running", "queued", "blocked", "failed", "interrupted"].includes(
      j.status,
    ),
  );
  const finished = state.jobs.filter((j) =>
    ["complete", "skipped", "cancelled"].includes(j.status),
  );
  if (!state.jobs.length) return null;

  const act = async (id: string, action: "cancel" | "retry") => {
    setBusy(true);
    try {
      await api.pipelineAiAction(id, action);
      await onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const visible = history ? state.jobs : active;

  return (
    <section
      className="activity-section automatic-queue"
      aria-label="Automatic AI queue"
    >
      <h2>Automatic AI</h2>
      {(state.embedding.needsReview || state.summary.needsReview) && (
        <p className="automatic-review">
          An AI provider changed after these jobs were queued. Save your
          choices in Settings → AI &amp; Search before retrying.
        </p>
      )}
      <div className="pipeline-jobs">
        {visible.map((j) => {
          const provider = state[j.action];
          return (
            <article className="pipeline-job" data-status={j.status} key={j.id}>
              <div className="pipeline-job-main">
                <div className="pipeline-job-title">
                  {j.status === "running" && (
                    <LoaderCircle size={15} className="spin" />
                  )}
                  <span>{j.title}</span>
                </div>
                <small>
                  {j.action === "embedding" ? "Semantic search" : "Summary"} ·{" "}
                  {j.target}
                </small>
                {(j.progress_message || j.message) && (
                  <p>
                    {j.status === "running"
                      ? j.progress_message || j.message
                      : j.message}
                  </p>
                )}
              </div>
              <div className="pipeline-job-actions">
                <Chip
                  tone={
                    j.status === "running"
                      ? "accent"
                      : j.status === "complete"
                        ? "success"
                        : ["failed", "interrupted", "blocked"].includes(
                              j.status,
                            )
                          ? "danger"
                          : "neutral"
                  }
                >
                  {labels[j.status] ?? j.status}
                  {j.status === "running" && j.total > 0
                    ? ` · ${j.done}/${j.total}`
                    : ""}
                </Chip>
                {["queued", "running"].includes(j.status) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={Square}
                    disabled={busy}
                    onClick={() => void act(j.id, "cancel")}
                  >
                    {j.status === "running" ? "Stop" : "Cancel"}
                  </Button>
                )}
                {["failed", "interrupted", "blocked", "cancelled"].includes(
                  j.status,
                ) && (
                  <Button
                    size="sm"
                    icon={RefreshCw}
                    disabled={
                      busy ||
                      !provider.enabled ||
                      !provider.ready ||
                      provider.needsReview
                    }
                    title={`Uses ${destination(provider.current)}`}
                    onClick={() => void act(j.id, "retry")}
                  >
                    Retry with {provider.current.model || "approved model"}
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {!!finished.length && (
        <Button
          size="sm"
          variant="ghost"
          icon={Clock}
          onClick={() => setHistory((v) => !v)}
        >
          {history ? "Hide" : "Show"} AI history ({finished.length})
        </Button>
      )}
    </section>
  );
}
