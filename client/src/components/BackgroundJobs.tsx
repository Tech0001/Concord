import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertCircle, CheckCircle, Loader2, PauseCircle, RefreshCw, RotateCcw, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface BackgroundJob {
  id: string;
  type: "segment_embeddings" | "doc_embeddings" | "note_embeddings" | "video_summaries";
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  label: string;
  payload: { model: string };
  progress_done: number;
  progress_total: number;
  result: { written: number; skipped: number; failed: number; units: number; errors: { item: string; error: string }[] } | null;
  error: string | null;
  cancel_requested: boolean;
  created_at: string;
  updated_at: string;
}

const statusIcon = {
  queued: PauseCircle,
  running: Loader2,
  completed: CheckCircle,
  failed: AlertCircle,
  cancelled: XCircle,
};

function resultUnit(job: BackgroundJob): string {
  if (!job.result?.units) return "";
  if (job.type === "segment_embeddings") return `${job.result.units.toLocaleString()} segments`;
  if (job.type === "doc_embeddings") return `${job.result.units.toLocaleString()} chunks`;
  if (job.type === "note_embeddings") return `${job.result.units.toLocaleString()} notes`;
  return `${job.result.units.toLocaleString()} output chars`;
}

export function BackgroundJobs({ limit = 10 }: { limit?: number }) {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/background-jobs?limit=${limit}`, { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json() as { jobs?: BackgroundJob[] };
      setJobs(data.jobs ?? []);
    } finally {
      setLoading(false);
    }
  }, [limit]);

  const active = useMemo(() => jobs.some(job => job.status === "running" || job.status === "queued"), [jobs]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), active ? 2_000 : 15_000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const mutate = async (job: BackgroundJob, action: "cancel" | "retry") => {
    await fetch(`/api/background-jobs/${encodeURIComponent(job.id)}/${action}`, { method: "POST" });
    void load();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Activity className="h-4 w-4 text-muted-foreground" />
          Durable background jobs
        </CardTitle>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void load()} title="Refresh jobs">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        {loading && jobs.length === 0 && <div className="text-xs text-muted-foreground">Loading jobs…</div>}
        {!loading && jobs.length === 0 && (
          <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
            No background jobs yet. Embedding and summary backfills will appear here.
          </div>
        )}
        {jobs.map(job => {
          const Icon = statusIcon[job.status];
          const percent = job.progress_total > 0 ? Math.min(100, job.progress_done / job.progress_total * 100) : job.status === "completed" ? 100 : 0;
          const result = job.result;
          const firstError = job.error || result?.errors?.[0]?.error;
          return (
            <div key={job.id} className="space-y-1.5 rounded-md border bg-muted/20 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <Icon className={`h-3.5 w-3.5 ${job.status === "running" ? "animate-spin" : ""}`} />
                <span className="min-w-0 flex-1 truncate font-medium">{job.label}</span>
                <Badge variant={job.status === "failed" ? "destructive" : "outline"} className="text-[10px]">{job.status}</Badge>
                {(job.status === "queued" || job.status === "running") && (
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" disabled={job.cancel_requested} onClick={() => void mutate(job, "cancel")}>
                    {job.cancel_requested ? "Stopping…" : "Cancel"}
                  </Button>
                )}
                {(job.status === "failed" || job.status === "cancelled") && (
                  <Button size="sm" variant="ghost" className="h-6 gap-1 px-2 text-[10px]" onClick={() => void mutate(job, "retry")}>
                    <RotateCcw className="h-3 w-3" />Resume
                  </Button>
                )}
              </div>
              <div className="h-1.5 overflow-hidden rounded bg-secondary">
                <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-3 text-[10px] text-muted-foreground">
                <span>{job.progress_done.toLocaleString()} / {job.progress_total.toLocaleString()} · <code>{job.payload.model}</code></span>
                {result && (
                  <span>
                    {result.written} done · {result.skipped} skipped{result.failed ? ` · ${result.failed} failed` : ""}
                    {resultUnit(job) ? ` · ${resultUnit(job)}` : ""}
                  </span>
                )}
              </div>
              {firstError && <div className="line-clamp-2 text-[10px] text-destructive">{firstError}</div>}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

