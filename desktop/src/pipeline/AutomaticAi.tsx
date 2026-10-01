import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  Clock,
  LoaderCircle,
  RefreshCw,
  Square,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { AiTarget, AutomaticAi } from "./types.ts";

function destination(t: AiTarget) {
  return `${t.model || "No model selected"} · ${t.kind === "builtin" ? "Built-in, on this computer" : t.kind === "chatgpt" ? "ChatGPT plan" : t.kind === "openrouter" ? "OpenRouter" : t.baseUrl}`;
}
export function AutomaticSetup({
  state,
  onChanged,
}: {
  state: AutomaticAi;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const { navigate } = useApp();
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
      toast.success("Automatic AI actions saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="pipeline-card automatic-setup"
      aria-label="After transcription"
    >
      <h2>After transcription</h2>
      <p>
        Optional actions for recordings that finish processing from now on. Each
        has its own model. They run independently of speech processing; your
        transcript remains available if AI fails.
      </p>
      {(
        [
          ["embedding", "Add to semantic search", embedding, setEmbedding],
          ["summary", "Generate a summary", summary, setSummary],
        ] as const
      ).map(([key, label, checked, change]) => (
        <div className="automatic-option" key={key}>
          <label className="pipeline-checkbox">
            <input
              type="checkbox"
              checked={checked}
              disabled={busy || (!state[key].ready && !checked)}
              onChange={(e) => {
                change(e.target.checked);
                setDirty(true);
              }}
            />
            {label}
          </label>
          <p>{destination(state[key].current)}</p>
          <small>
            {state[key].local
              ? "Transcript text stays on this computer."
              : "Transcript text is sent to this provider and may use paid credits or plan usage."}
          </small>
          {!state[key].ready && (
            <p>Configure and enable this model in Settings first.</p>
          )}
          {state[key].needsReview && (
            <p className="automatic-review">
              The model or provider changed. Save these choices to approve it
              for future recordings. Pending jobs need an explicit retry.
            </p>
          )}
        </div>
      ))}
      <p>
        Existing archive recordings are not backfilled. Saved summaries are
        kept. Turning an action off cancels its pending work and stops its
        automatic job. An embedding request already in progress finishes first;
        manual AI jobs keep running.
      </p>
      <div className="automatic-actions">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          Save AI actions
        </Button>
        <Button
          variant="ghost"
          icon={ArrowUpRight}
          onClick={() => navigate({ page: "settings" })}
        >
          AI provider settings
        </Button>
      </div>
    </section>
  );
}
const labels: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  blocked: "Needs review",
  complete: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  skipped: "Skipped",
};
export function AutomaticQueue({
  state,
  onChanged,
}: {
  state: AutomaticAi;
  onChanged: () => Promise<void>;
}) {
  const toast = useToast();
  const { navigate } = useApp();
  const [history, setHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = state.jobs.filter(
    (j) => !["complete", "cancelled", "skipped"].includes(j.status),
  );
  const finished = state.jobs.filter((j) =>
    ["complete", "cancelled", "skipped"].includes(j.status),
  );
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
  if (!state.jobs.length) return null;
  return (
    <section className="automatic-queue" aria-label="Automatic AI queue">
      <h2>After transcription</h2>
      <p>
        Indexing and summaries have their own queue. Stop or retry them here
        without transcribing again.
      </p>
      <div className="pipeline-jobs">
        {[...active, ...(history ? finished : [])].map((j) => {
          const provider = state[j.action];
          return (
            <article className="pipeline-job" data-status={j.status} key={j.id}>
              <div className="pipeline-job-main">
                <button
                  className="pipeline-job-title"
                  onClick={() =>
                    navigate({ page: "recording", id: j.media_id })
                  }
                >
                  {j.title}
                  <ArrowUpRight size={13} />
                </button>
                <small>
                  {j.action === "embedding" ? "Semantic search" : "Summary"} ·{" "}
                  {destination(JSON.parse(j.target) as AiTarget)}
                </small>
                <p>{j.progress_message || j.message}</p>
                {j.status === "running" && j.total > 0 && (
                  <small>
                    {j.done} / {j.total}
                  </small>
                )}
              </div>
              <div className="pipeline-job-actions">
                <Chip
                  tone={
                    j.status === "complete"
                      ? "success"
                      : ["failed", "blocked"].includes(j.status)
                        ? "danger"
                        : "neutral"
                  }
                >
                  {j.status === "running" && (
                    <LoaderCircle size={12} className="spin" />
                  )}
                  {labels[j.status] || j.status}
                </Chip>
                {["queued", "running", "blocked"].includes(j.status) && (
                  <Button
                    size="sm"
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
