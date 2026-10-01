import { useEffect, useState } from "react";
import { Activity, LoaderCircle, RefreshCw, Square, X } from "lucide-react";
import { IndexControl } from "../ai/IndexControl.tsx";
import "../ai/ai.css";
import { api } from "../lib/ipc.ts";
import type { Job, Runtime } from "../lib/types.ts";
import { useApp } from "./AppContext.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Empty } from "../ui/Empty.tsx";
import { useToast } from "../ui/Toasts.tsx";

const LABEL: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  complete: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};
export function ActivityPanel({
  open,
  onOpenChange,
  jobs,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobs: Job[];
  onChanged: () => void;
}) {
  const toast = useToast();
  const { transcribe, navigate } = useApp();
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Runtime>();
  const [version, setVersion] = useState("");
  const [checking, setChecking] = useState(false);
  const check = async () => {
    setChecking(true);
    try {
      const [runtime, version] = await Promise.all([
        api.speechStatus(),
        api.version(),
      ]);
      setHealth(runtime);
      setVersion(version);
    } catch (e) {
      toast.error(e);
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (open) void check();
  }, [open]);
  const active = jobs.filter((j) => ["running", "queued"].includes(j.status));
  const finished = jobs.filter(
    (j) => !["running", "queued"].includes(j.status),
  );
  const clear = async (id?: string) => {
    setBusy(true);
    try {
      await api.clearJobs(id);
      onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const retry = async (j: Job) => {
    setBusy(true);
    try {
      await transcribe(j.media_id);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const row = (j: Job) => (
    <li key={j.id} className="job">
      <div className="job-head">
        <button
          className="job-title"
          onClick={() => {
            onOpenChange(false);
            navigate({ page: "recording", id: j.media_id });
          }}
        >
          {j.title}
        </button>
        <Chip
          tone={
            j.status === "running"
              ? "accent"
              : j.status === "complete"
                ? "success"
                : ["failed", "interrupted"].includes(j.status)
                  ? "danger"
                  : "neutral"
          }
        >
          {j.status === "running" && (
            <LoaderCircle size={12} className="spin" />
          )}
          {LABEL[j.status] ?? j.status}
        </Chip>
      </div>
      {j.created_at && (
        <small className="muted">
          {new Date(
            j.created_at.includes("T")
              ? j.created_at
              : `${j.created_at.replace(" ", "T")}Z`,
          ).toLocaleString()}
        </small>
      )}
      {j.message && <p className="job-message">{j.message}</p>}
      {j.status === "running" ? (
        <Button
          size="sm"
          variant="ghost"
          icon={Square}
          onClick={() => api.cancelTranscription().catch(toast.error)}
        >
          Cancel processing
        </Button>
      ) : (
        j.status !== "queued" && (
          <div className="job-actions">
            {["failed", "interrupted", "cancelled"].includes(j.status) && (
              <Button
                size="sm"
                icon={RefreshCw}
                disabled={busy || !!active.length}
                onClick={() => void retry(j)}
              >
                Retry
              </Button>
            )}
            <IconButton
              size="sm"
              icon={X}
              label={`Dismiss ${j.title} attempt`}
              disabled={busy}
              onClick={() => void clear(j.id)}
            />
          </div>
        )
      )}
    </li>
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Status & Health"
      variant="side"
    >
      <div className="health-heading">
        <Chip tone={health?.ready ? "success" : "warn"}>
          {health
            ? health.ready
              ? "Speech ready"
              : "Speech setup needed"
            : "Checking speech…"}
        </Chip>
        <Button
          size="sm"
          icon={RefreshCw}
          disabled={checking}
          onClick={() => void check()}
        >
          Check health
        </Button>
      </div>
      {health && (
        <details className="health-console">
          <summary>Diagnostics</summary>
          <pre>
            {[
              `Concord Next ${version}`,
              `Device: ${health.device}${health.gpu ? ` · ${health.gpu}` : ""}`,
              `Speech models: ${health.modelsReady ? "available" : "missing"}`,
              `Voice matching: ${health.voiceMatchingReady ? "available" : "missing"}`,
              `Model: ${health.model}`,
              `Models folder: ${health.models}`,
              `Voice runtime: ${health.python}`,
            ].join("\n")}
          </pre>
        </details>
      )}
      {open && <IndexControl />}

      {active.length ? (
        <ul className="job-list">{active.map(row)}</ul>
      ) : (
        <Empty
          icon={Activity}
          title="Nothing running"
          text="Finished attempts are listed in recent activity below."
        />
      )}
      {!!finished.length && (
        <details className="job-history">
          <summary>
            Recent activity · {finished.length} finished attempts
          </summary>
          <p className="muted">
            These are past attempts, saved between launches. Retrying creates a
            new attempt.
          </p>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void clear()}
          >
            Clear finished
          </Button>
          <ul className="job-list">{finished.map(row)}</ul>
        </details>
      )}
    </Dialog>
  );
}
