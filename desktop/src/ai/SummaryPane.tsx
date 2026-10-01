import { ChatGPTUsage } from "./ChatGPTSettings.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, RefreshCw, Square } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { Markdown } from "../documents/Markdown.tsx";
import { chatReady, type AiConfig, type SummaryState } from "./types.ts";
import "./ai.css";

export function SummaryPane({ id, title }: { id: string; title: string }) {
  const [state, setState] = useState<SummaryState>();
  const [config, setConfig] = useState<AiConfig>();
  const [busy, setBusy] = useState(false);
  const { navigate, openNote, refresh } = useApp();
  const toast = useToast();
  const lastJob = useRef("");
  const reload = useCallback(
    async () => setState(await api.aiSummaryState(id)),
    [id],
  );
  useEffect(() => {
    let alive = true;
    void api
      .aiConfig()
      .then((value) => {
        if (alive) setConfig(value);
      })
      .catch(toast.error);
    return () => {
      alive = false;
    };
  }, [toast]);
  useEffect(() => {
    let alive = true,
      timer = 0;
    const poll = async () => {
      let delay = 2000;
      try {
        const value = await api.aiSummaryState(id);
        if (!alive) return;
        setState(value);
        delay = value.job?.status === "running" ? 500 : 2000;
        const signature = value.job
          ? `${value.job.id}:${value.job.status}`
          : "";
        if (
          lastJob.current &&
          signature !== lastJob.current &&
          value.job?.status === "complete"
        )
          refresh();
        lastJob.current = signature;
      } catch (e) {
        if (alive) toast.error(e);
      }
      if (alive) timer = window.setTimeout(poll, delay);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, toast, refresh]);
  const generate = async () => {
    setBusy(true);
    try {
      await api.aiStartSummary(id);
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await api.aiCancelSummary(id);
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const summary = state?.summary,
    job = state?.job,
    active = job?.status === "running";
  return (
    <div className="summary-pane">
      {active && (
        <div className="summary-job" role="status">
          <strong>{job.message}</strong>
          <progress
            aria-label="Summary progress"
            max={job.total || 1}
            value={job.done}
          />
          <small>
            {job.done} / {job.total} requests completed · {job.model}
          </small>
          <p className="muted">
            You can leave this recording; generation continues in the
            background.
          </p>
          <Button icon={Square} disabled={busy} onClick={() => void cancel()}>
            Stop summary
          </Button>
        </div>
      )}
      {job && ["failed", "cancelled", "interrupted"].includes(job.status) && (
        <p
          className={job.status === "failed" ? "field-error" : "muted"}
          role="status"
        >
          {job.message}
        </p>
      )}
      {summary ? (
        <>
          <Markdown source={summary.content} />
          <p className="muted">
            Generated with {summary.model}
            {active && " · shown until the replacement is ready"}
          </p>
          <Button
            size="sm"
            onClick={() =>
              openNote({
                title: `${title} · Summary`,
                body: summary.content,
                media_id: id,
                start: 0,
              })
            }
          >
            Save as note
          </Button>
        </>
      ) : (
        !active && (
          <Empty
            icon={FileText}
            title="Recording summary"
            text="Summarize the full transcript with your chosen chat model. Long recordings are summarized in sections."
          />
        )
      )}
      {!active &&
        (chatReady(config?.chat) ? (
          <>
            <p className="muted">
              {config?.chat.local
                ? "Uses the chat model on this computer."
                : "Sends transcript text to your chat provider. Long recordings require multiple requests."}
            </p>
            {config?.chat.kind === "chatgpt" && <ChatGPTUsage/>}
            <Button
              icon={RefreshCw}
              disabled={busy || !state}
              onClick={() => void generate()}
            >
              {busy
                ? "Starting summary…"
                : summary
                  ? "Regenerate summary"
                  : "Generate summary"}
            </Button>
          </>
        ) : (
          <Button onClick={() => navigate({ page: "settings" })}>
            Set up chat in Settings
          </Button>
        ))}
    </div>
  );
}
