import { useCallback, useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Activity,
  AlertTriangle,
  Bot,
  Clock,
  Database,
  FileText,
  Mic,
  RefreshCw,
  Sparkles,
  Users,
  Video,
} from "lucide-react";

interface PipelineJob {
  id: string;
  channelId: string;
  channelName: string;
  videoId: string;
  videoTitle: string;
  status: string;
  progress: number;
  startedAt: string;
  model?: string;
}

interface PipelineState {
  status: "idle" | "running" | "sleeping" | "stopped";
  lastCheck: string | null;
  nextCheck: string | null;
  totalCompleted: number;
  pendingCount: number;
  jobs: PipelineJob[];
  dailyDownloadCount: number;
  dailyDownloadCap: number;
}

interface ChannelRollup {
  id: string;
  name: string;
  enabled: boolean;
  diarize: boolean;
  includeShorts: boolean;
  totalVideos: number;
  completedVideos: number;
  pendingVideos: number;
  failedVideos: number;
  embeddedVideos: number;
  summarizedVideos: number;
  diarizedVideos: number;
}

interface StatusSnapshot {
  pipeline: PipelineState;
  archive: {
    channelCount: number;
    enabledChannelCount: number;
    totalVideos: number;
    completedVideos: number;
    pendingVideos: number;
    failedVideos: number;
    inflightVideos: number;
    shortsVideos: number;
    totalDurationSeconds: number;
    totalWordCount: number;
  };
  coverage: {
    transcripts: { covered: number; total: number };
    diarization: { covered: number; applicable: number };
    aiSummaries: { covered: number; total: number };
    fts: { files: number; segments: number };
    embeddings: {
      activeModel: string | null;
      models: { model: string; videos: number; segments: number }[];
      activeModelCovered: number;
      activeModelTotal: number;
    };
  };
  speakers: {
    total: number;
    labeled: number;
    noise: number;
    videosWithDiarization: number;
    unidentifiedClusters: number;
  };
  channels: ChannelRollup[];
  recentFailures: {
    videoId: string;
    channelId: string;
    title: string;
    status: string;
    error: string | null;
    updatedAt: string;
  }[];
}

interface LlmStatus {
  reachable: boolean;
  latencyMs?: number;
  errorKind?: string;
}

const fmtNumber = (n: number) => n.toLocaleString();

const fmtHours = (seconds: number): string => {
  const h = seconds / 3600;
  if (h >= 100) return `${h.toFixed(0)} h`;
  if (h >= 10) return `${h.toFixed(1)} h`;
  return `${h.toFixed(2)} h`;
};

const fmtTime = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const pctColor = (covered: number, total: number): string => {
  if (total === 0) return "bg-muted";
  const ratio = covered / total;
  if (ratio >= 0.99) return "bg-emerald-500";
  if (ratio >= 0.6) return "bg-amber-500";
  return "bg-zinc-500";
};

function Bar({ covered, total }: { covered: number; total: number }) {
  const pct = total === 0 ? 0 : Math.min(100, (covered / total) * 100);
  return (
    <div className="h-1.5 overflow-hidden rounded bg-secondary">
      <div className={cn("h-full transition-[width]", pctColor(covered, total))} style={{ width: `${pct}%` }} />
    </div>
  );
}

function CoverageCard({
  title,
  icon: Icon,
  covered,
  total,
  totalLabel,
  hint,
  cta,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  covered: number;
  total: number;
  totalLabel?: string;
  hint?: string;
  cta?: { label: string; href: string };
}) {
  const gap = Math.max(0, total - covered);
  const pct = total === 0 ? 0 : Math.round((covered / total) * 100);
  return (
    <Card>
      <CardHeader className="space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-xl tabular-nums">
            {fmtNumber(covered)}
            <span className="ml-1 text-sm text-muted-foreground">/ {fmtNumber(total)}</span>
          </span>
          <span className="text-xs text-muted-foreground">{pct}%</span>
        </div>
        <Bar covered={covered} total={total} />
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{totalLabel || "of complete videos"}</span>
          <span>{gap === 0 ? "all caught up" : `${fmtNumber(gap)} missing`}</span>
        </div>
        {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
        {cta && (
          <div className="pt-1">
            <Link href={cta.href}>
              <Button size="sm" variant="outline" className="h-7 text-xs">
                {cta.label}
              </Button>
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatPill({ label, value, icon: Icon }: { label: string; value: string | number; icon?: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2">
      {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      <div className="flex flex-col leading-tight">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="font-mono text-sm tabular-nums">{value}</span>
      </div>
    </div>
  );
}

function PipelineStatusPill({ status }: { status: PipelineState["status"] }) {
  const config = {
    running: { label: "Running", color: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
    sleeping: { label: "Sleeping", color: "bg-sky-500", text: "text-sky-700 dark:text-sky-400" },
    idle: { label: "Idle", color: "bg-zinc-400", text: "text-zinc-700 dark:text-zinc-400" },
    stopped: { label: "Stopped", color: "bg-zinc-400", text: "text-zinc-700 dark:text-zinc-400" },
  }[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", config.text)}>
      <span className={cn("inline-block h-2 w-2 rounded-full", config.color, status === "running" && "animate-pulse")} />
      Pipeline · {config.label}
    </span>
  );
}

function LlmPill({ status }: { status: LlmStatus | null }) {
  const color =
    !status ? "bg-muted" :
    status.reachable ? "bg-emerald-500" :
    status.errorKind === "http" ? "bg-amber-500" : "bg-zinc-500";
  const label =
    !status ? "Probing…" :
    status.reachable ? `LLM · OK${status.latencyMs ? ` (${status.latencyMs}ms)` : ""}` :
    status.errorKind === "config" ? "LLM · not configured" :
    status.errorKind === "unreachable" ? "LLM · unreachable" :
    status.errorKind === "http" ? "LLM · auth/HTTP error" : "LLM · error";
  return (
    <Link href="/ai">
      <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary">
        <span className={cn("inline-block h-2 w-2 rounded-full", color)} />
        {label}
      </span>
    </Link>
  );
}

export default function Status() {
  const [snap, setSnap] = useState<StatusSnapshot | null>(null);
  const [llm, setLlm] = useState<LlmStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/status");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSnap(await r.json());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
    } finally {
      setLoading(false);
    }
  }, []);

  const probeLlm = useCallback(async () => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch("/api/llm/status", { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) setLlm(await r.json());
    } catch {
      setLlm({ reachable: false, errorKind: "unreachable" });
    }
  }, []);

  // Slow background poll — 5 min is plenty for a coverage dashboard.
  // The refresh button next to the pills is the right tool for "I want
  // a fresh number right now" without burning DB queries on a timer.
  useEffect(() => {
    load();
    probeLlm();
    const id = setInterval(load, 5 * 60 * 1000);
    const lid = setInterval(probeLlm, 5 * 60 * 1000);
    return () => { clearInterval(id); clearInterval(lid); };
  }, [load, probeLlm]);

  if (loading && !snap) {
    return <div className="mx-auto max-w-7xl px-4 py-8 text-sm text-muted-foreground">Loading status…</div>;
  }

  if (error && !snap) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-8">
        <Card><CardContent className="py-6 text-sm text-destructive">{error}</CardContent></Card>
      </div>
    );
  }

  if (!snap) return null;

  const { pipeline, archive, coverage, speakers, channels, recentFailures } = snap;
  const inflightLabel = archive.inflightVideos > 0 ? `${archive.inflightVideos} in flight · ` : "";

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      {/* Header strip */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Status</h1>
          <p className="text-xs text-muted-foreground">
            Single-glance view of the archive. {inflightLabel}{fmtNumber(archive.completedVideos)} videos complete · {fmtHours(archive.totalDurationSeconds)} archived.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <PipelineStatusPill status={pipeline.status} />
          <LlmPill status={llm} />
          <Button size="sm" variant="ghost" onClick={() => { load(); probeLlm(); }} className="h-8">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Quick stats row */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <StatPill icon={Video} label="Videos" value={fmtNumber(archive.totalVideos)} />
        <StatPill icon={Clock} label="Hours" value={fmtHours(archive.totalDurationSeconds)} />
        <StatPill icon={Activity} label="Pending" value={fmtNumber(archive.pendingVideos)} />
        <StatPill icon={AlertTriangle} label="Failed" value={fmtNumber(archive.failedVideos)} />
        <StatPill
          icon={Database}
          label={`Daily DLs${pipeline.dailyDownloadCap ? "" : " (no cap)"}`}
          value={pipeline.dailyDownloadCap ? `${pipeline.dailyDownloadCount} / ${pipeline.dailyDownloadCap}` : fmtNumber(pipeline.dailyDownloadCount)}
        />
        <StatPill icon={Users} label="Speakers" value={fmtNumber(speakers.labeled)} />
      </div>

      {/* Active jobs */}
      {pipeline.jobs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4 text-muted-foreground" />
              Active jobs ({pipeline.jobs.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 pt-0 text-xs">
            {pipeline.jobs.map((job) => (
              <div key={job.id} className="flex items-center gap-3 rounded border bg-muted/30 px-2.5 py-1.5">
                <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase">{job.status}</span>
                <span className="min-w-0 flex-1 truncate" title={job.videoTitle}>{job.videoTitle}</span>
                <span className="hidden text-muted-foreground sm:inline">{job.channelName}</span>
                {job.progress > 0 && (
                  <span className="font-mono tabular-nums text-muted-foreground">{Math.round(job.progress)}%</span>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Coverage cards */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <CoverageCard
          title="Transcripts"
          icon={FileText}
          covered={coverage.transcripts.covered}
          total={coverage.transcripts.total}
          hint={`FTS index: ${fmtNumber(coverage.fts.files)} files · ${fmtNumber(coverage.fts.segments)} segments`}
        />
        <CoverageCard
          title={`Semantic index${coverage.embeddings.activeModel ? ` · ${coverage.embeddings.activeModel}` : ""}`}
          icon={Database}
          covered={coverage.embeddings.activeModelCovered}
          total={coverage.embeddings.activeModelTotal}
          hint={
            coverage.embeddings.activeModel
              ? "Click reindex to fill in missing videos."
              : "No embedding model configured — set one on the AI page."
          }
          cta={{ label: "Open AI page", href: "/ai" }}
        />
        <CoverageCard
          title="AI summaries"
          icon={Sparkles}
          covered={coverage.aiSummaries.covered}
          total={coverage.aiSummaries.total}
        />
        <CoverageCard
          title="Diarization"
          icon={Mic}
          covered={coverage.diarization.covered}
          total={coverage.diarization.applicable}
          totalLabel="of diarize-enabled videos"
          hint={`${fmtNumber(speakers.unidentifiedClusters)} unidentified clusters waiting on labels`}
          cta={{ label: "Open Speakers", href: "/speakers" }}
        />
      </div>

      {/* Embeddings model breakdown (when more than one) */}
      {coverage.embeddings.models.length > 1 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="h-4 w-4 text-muted-foreground" />
              Stored embedding models ({coverage.embeddings.models.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-0 text-xs">
            {coverage.embeddings.models.map((m) => (
              <div key={m.model} className="flex items-baseline justify-between rounded border bg-muted/30 px-2 py-1">
                <code className="font-mono">{m.model}{m.model === coverage.embeddings.activeModel && <span className="ml-2 text-[10px] uppercase text-emerald-600">active</span>}</code>
                <span className="text-muted-foreground">{fmtNumber(m.videos)} videos · {fmtNumber(m.segments)} segments</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Channels rollup */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Bot className="h-4 w-4 text-muted-foreground" />
            Channels ({archive.enabledChannelCount} enabled / {archive.channelCount} total)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-2">Channel</th>
                  <th className="py-1.5 px-2 text-right">Videos</th>
                  <th className="py-1.5 px-2 text-right">Done</th>
                  <th className="py-1.5 px-2 text-right">Pending</th>
                  <th className="py-1.5 px-2 text-right">Failed</th>
                  <th className="py-1.5 px-2 text-right">Embed</th>
                  <th className="py-1.5 px-2 text-right">Sum</th>
                  <th className="py-1.5 px-2 text-right">Diar</th>
                  <th className="py-1.5 pl-2 text-right">Flags</th>
                </tr>
              </thead>
              <tbody>
                {channels.length === 0 && (
                  <tr><td colSpan={9} className="py-3 text-center text-muted-foreground">No channels configured.</td></tr>
                )}
                {channels.map((c) => {
                  const dim = !c.enabled ? "text-muted-foreground" : "";
                  return (
                    <tr key={c.id} className={cn("border-b last:border-0", dim)}>
                      <td className="py-1.5 pr-2 font-medium">{c.name}</td>
                      <td className="px-2 text-right font-mono tabular-nums">{fmtNumber(c.totalVideos)}</td>
                      <td className="px-2 text-right font-mono tabular-nums">{fmtNumber(c.completedVideos)}</td>
                      <td className="px-2 text-right font-mono tabular-nums">{fmtNumber(c.pendingVideos)}</td>
                      <td className={cn("px-2 text-right font-mono tabular-nums", c.failedVideos > 0 && "text-amber-600 dark:text-amber-400")}>{fmtNumber(c.failedVideos)}</td>
                      <td className={cn("px-2 text-right font-mono tabular-nums", c.embeddedVideos < c.completedVideos && "text-zinc-500")}>{fmtNumber(c.embeddedVideos)}</td>
                      <td className={cn("px-2 text-right font-mono tabular-nums", c.summarizedVideos < c.completedVideos && "text-zinc-500")}>{fmtNumber(c.summarizedVideos)}</td>
                      <td className={cn("px-2 text-right font-mono tabular-nums", c.diarize && c.diarizedVideos < c.completedVideos && "text-zinc-500")}>{c.diarize ? fmtNumber(c.diarizedVideos) : "—"}</td>
                      <td className="pl-2 text-right text-[10px] text-muted-foreground">
                        {[
                          !c.enabled && "OFF",
                          c.diarize && "diar",
                          c.includeShorts && "shorts",
                        ].filter(Boolean).join(" · ") || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Recent failures */}
      {recentFailures.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Recent failures ({recentFailures.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 pt-0 text-xs">
            {recentFailures.map((f) => (
              <div key={`${f.channelId}:${f.videoId}`} className="rounded border bg-muted/30 px-2.5 py-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium" title={f.title}>{f.title}</span>
                  <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] uppercase">{f.status}</span>
                  <span className="text-[10px] text-muted-foreground">{fmtTime(f.updatedAt)}</span>
                </div>
                {f.error && (
                  <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{f.error}</div>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="text-[10px] text-muted-foreground">
        Last refresh: {new Date().toLocaleTimeString()} · auto-refresh every 5 min — use the refresh button for a fresh snapshot.
      </div>
    </div>
  );
}
