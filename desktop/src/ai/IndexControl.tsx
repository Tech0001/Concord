import { useEffect, useState } from "react";
import { Database, RefreshCw, Square, Trash2 } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { IndexStatus } from "./types.ts";

export function IndexControl({
  compact = false,
  showClear = false,
  hideWhenIdle = false,
  onStatus,
}: {
  compact?: boolean;
  showClear?: boolean;
  hideWhenIdle?: boolean;
  onStatus?: (status: IndexStatus) => void;
}) {
  const [status, setStatus] = useState<IndexStatus>();
  const [busy, setBusy] = useState(false);
  const [clear, setClear] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await api.aiStatus();
        if (alive) {
          setStatus(next);
          onStatus?.(next);
        }
      } catch (e) {
        if (alive) toast.error(e);
      }
      if (alive) timer = window.setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [toast, onStatus]);

  const run = async () => {
    setBusy(true);
    try {
      await api.aiIndex();
      const next = await api.aiStatus();
      setStatus(next);
      onStatus?.(next);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const running = status?.job?.status === "running";
  const failed = status?.job?.status === "failed";
  if (hideWhenIdle && !running && !failed) return null;

  const indexed = status?.indexed ?? 0;
  const total = status?.total ?? 0;
  const pct =
    running && status?.job && status.job.total > 0
      ? Math.round((status.job.done / status.job.total) * 100)
      : null;

  return (
    <section
      className={`ai-index${compact ? " is-compact" : ""}`}
      aria-label="Semantic search index"
    >
      <div className="ai-index-body">
        <strong>
          <Database size={15} aria-hidden /> Semantic search index
          {pct != null && <span className="ai-index-pct num">{pct}%</span>}
        </strong>
        <p>
          {status
            ? `${indexed.toLocaleString()} of ${total.toLocaleString()} sources indexed · ${status.chunks.toLocaleString()} passages`
            : "Checking index…"}
          {status?.device ? ` · ${status.device}` : ""}
        </p>
        {!status?.modelReady && (
          <small>
            Downloads the built-in local model once (639 MB), then runs on this
            computer without an API key.
          </small>
        )}
        {status?.job && (running || failed || status.job.status === "cancelled") && (
          <p
            role="status"
            className={failed ? "is-error" : "muted"}
          >
            {status.job.message}
            {running &&
              status.job.total > 0 &&
              ` · ${status.job.done.toLocaleString()} / ${status.job.total.toLocaleString()}`}
          </p>
        )}
        {running && status?.job && (
          <progress
            max={status.job.total || 1}
            value={status.job.done}
            aria-label="Indexing progress"
          />
        )}
      </div>
      <div className="ai-index-actions">
        {running ? (
          <Button
            size="sm"
            icon={Square}
            onClick={() => api.aiCancelIndex().catch(toast.error)}
          >
            Stop indexing
          </Button>
        ) : (
          <Button
            size="sm"
            variant={indexed === 0 ? "primary" : "secondary"}
            icon={RefreshCw}
            disabled={busy || !status}
            onClick={() => void run()}
          >
            {indexed > 0 ? "Update search index" : "Build search index"}
          </Button>
        )}
        {showClear && !running && indexed > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            onClick={() => setClear(true)}
          >
            Clear index…
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={clear}
        onOpenChange={setClear}
        title="Clear search index?"
        body="This removes only the current embedding model's vectors. Your recordings, documents, notes and chats are kept. Click Build search index anytime to rebuild it."
        confirmLabel="Clear index"
        onConfirm={async () => {
          try {
            await api.aiClearIndex();
            const next = await api.aiStatus();
            setStatus(next);
            onStatus?.(next);
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
