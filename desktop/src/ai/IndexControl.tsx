import { useEffect, useState } from "react";
import { Database, RefreshCw, Square } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { IndexStatus } from "./types.ts";
export function IndexControl() {
  const [status, setStatus] = useState<IndexStatus>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await api.aiStatus();
        if (alive) setStatus(next);
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
  }, [toast]);
  const run = async () => {
    setBusy(true);
    try {
      await api.aiIndex();
      setStatus(await api.aiStatus());
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const running = status?.job?.status === "running";
  return (
    <section className="ai-index" aria-label="Semantic search index">
      <div>
        <strong>
          <Database size={15} /> Semantic search index
        </strong>
        <p>
          {status
            ? `${status.indexed.toLocaleString()} of ${status.total.toLocaleString()} sources indexed · ${status.chunks.toLocaleString()} passages`
            : "Checking index…"}
        </p>
        {!status?.modelReady && (
          <small>
            The built-in model downloads once (639 MB), then runs on this
            computer without an API key.
          </small>
        )}
        {status?.job && (
          <p
            role="status"
            className={status.job.status === "failed" ? "is-error" : "muted"}
          >
            {status.job.message}
            {running &&
              status.job.total > 0 &&
              ` · ${status.job.done}/${status.job.total}`}
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
          icon={RefreshCw}
          disabled={busy || !status}
          onClick={() => void run()}
        >
          {status?.indexed ? "Update index" : "Prepare semantic search"}
        </Button>
      )}
    </section>
  );
}
