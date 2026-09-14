import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertCircle, AlertTriangle, ArchiveRestore, CheckCircle2, DatabaseBackup, ExternalLink, HardDrive, Loader2, RefreshCw, ShieldCheck, Stethoscope, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import FolderInput from "@/components/FolderInput";
import FileInput from "@/components/FileInput";
import { BackgroundJobs } from "@/components/BackgroundJobs";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type RepairAction = "reindex-transcripts" | "thumbnails" | "segment-embeddings" | "doc-embeddings" | "clean-derived-indexes" | "fingerprints";

interface HealthItem { id: string; title: string; detail?: string; href?: string }
interface HealthIssue {
  id: string;
  category: string;
  severity: "error" | "warning" | "info";
  title: string;
  description: string;
  count: number;
  items: HealthItem[];
  repairAction?: RepairAction;
}
interface HealthReport {
  generatedAt: string;
  expectedEmbeddingDimensions: number;
  activeEmbeddingModel: string | null;
  lastDimensionCheck: { model: string; dimensions: number; checkedAt: string } | null;
  summary: { errors: number; warnings: number; healthy: boolean };
  issues: HealthIssue[];
  storage: { databasePath: string; databaseBytes: number; mediaBytes: number; roots: { path: string; available: boolean }[] };
}

const repairLabels: Record<RepairAction, string> = {
  "reindex-transcripts": "Rebuild search index",
  thumbnails: "Generate missing thumbnails",
  "segment-embeddings": "Embed missing transcripts",
  "doc-embeddings": "Embed missing documents",
  "clean-derived-indexes": "Clean derived rows",
  fingerprints: "Scan media fingerprints",
};

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
}

export default function Health() {
  const { toast } = useToast();
  const [report, setReport] = useState<HealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [repairing, setRepairing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [backupFolder, setBackupFolder] = useState("");
  const [restoreFile, setRestoreFile] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/archive-health", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setReport(data);
    } catch (error) {
      toast({ variant: "destructive", title: "Archive audit failed", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const repair = async (action: RepairAction) => {
    setRepairing(action);
    try {
      const response = await fetch("/api/archive-health/repair", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      toast({
        title: data.job ? "Repair queued" : "Repair complete",
        description: data.job ? `${data.job.label} will continue in the background.` : `${repairLabels[action]} finished.`,
      });
      // Background repairs report progress in the jobs panel below. Running
      // another full audit immediately can contend with a large maintenance
      // job and makes the page look stuck even though the repair was queued.
      if (!data.job) await load();
    } catch (error) {
      toast({ variant: "destructive", title: "Repair failed", description: error instanceof Error ? error.message : String(error) });
    } finally {
      setRepairing(null);
    }
  };

  const checkDimensions = async () => {
    setRepairing("dimensions");
    try {
      const response = await fetch("/api/archive-health/check-embedding-model", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      toast({ title: "Embedding model is compatible", description: `${data.model} returns ${data.dimensions} dimensions.` });
      await load();
    } catch (error) {
      toast({ variant: "destructive", title: "Embedding model is incompatible", description: error instanceof Error ? error.message : String(error) });
    } finally { setRepairing(null); }
  };

  const createBackup = async () => {
    if (!backupFolder.trim()) return;
    setBackupBusy(true);
    try {
      const response = await fetch("/api/backups", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder: backupFolder }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      toast({ title: "Backup complete", description: `${data.backup.path} · ${formatBytes(data.backup.bytes)}` });
    } catch (error) {
      toast({ variant: "destructive", title: "Backup failed", description: error instanceof Error ? error.message : String(error) });
    } finally { setBackupBusy(false); }
  };

  const restore = async () => {
    if (!restoreFile.trim()) return;
    try {
      const validationResponse = await fetch("/api/backups/validate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: restoreFile }),
      });
      const validation = await validationResponse.json();
      if (!validationResponse.ok) throw new Error(validation.error || "Backup validation failed");
      const accepted = confirm(
        `Stage this backup for restore?\n\n${validation.videos} media records · ${validation.notes} notes · ${validation.documents} documents\n\nIt will replace the active research database after Concord restarts. The current database will be preserved beside it as a pre-restore copy. Media files are not changed.`,
      );
      if (!accepted) return;
      setBackupBusy(true);
      const response = await fetch("/api/backups/restore", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file: restoreFile, confirmed: true }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Restore could not be staged");
      toast({ title: "Restore staged", description: "Restart Concord to apply it. Your current database will be retained as a pre-restore copy." });
    } catch (error) {
      toast({ variant: "destructive", title: "Restore failed", description: error instanceof Error ? error.message : String(error) });
    } finally { setBackupBusy(false); }
  };

  const grouped = useMemo(() => {
    const map = new Map<string, HealthIssue[]>();
    for (const issue of report?.issues || []) map.set(issue.category, [...(map.get(issue.category) || []), issue]);
    return Array.from(map.entries());
  }, [report]);

  if (loading && !report) return <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-muted-foreground">Auditing the archive…</div>;

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight"><Stethoscope className="h-5 w-5" />Archive Health & Repair</h1>
          <p className="mt-1 text-xs text-muted-foreground">Local integrity checks, safe repairs, provenance coverage, and recoverable database backups.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")} />Run audit
        </Button>
      </div>

      {report && (
        <Card className={cn(report.summary.errors ? "border-destructive/50" : report.summary.warnings ? "border-amber-500/40" : "border-emerald-500/40")}>
          <CardContent className="flex flex-wrap items-center gap-4 py-4">
            {report.summary.healthy ? <ShieldCheck className="h-8 w-8 text-emerald-500" /> : <AlertTriangle className="h-8 w-8 text-amber-500" />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">{report.summary.healthy ? "Archive checks are clear" : "The archive needs attention"}</div>
              <div className="text-xs text-muted-foreground">{report.summary.errors} errors · {report.summary.warnings} warnings · scanned {new Date(report.generatedAt).toLocaleString()}</div>
            </div>
            <div className="flex gap-2 text-xs">
              <Badge variant="outline"><DatabaseBackup className="mr-1 h-3 w-3" />{formatBytes(report.storage.databaseBytes)} database</Badge>
              <Badge variant="outline"><HardDrive className="mr-1 h-3 w-3" />{formatBytes(report.storage.mediaBytes)} media</Badge>
            </div>
          </CardContent>
        </Card>
      )}

      {report && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Embedding compatibility guard</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 pt-0 text-xs">
            <div className="min-w-0 flex-1 text-muted-foreground">
              Index width: <code>{report.expectedEmbeddingDimensions}</code> · model: <code>{report.activeEmbeddingModel || "not configured"}</code>
              {report.lastDimensionCheck && <> · last verified {new Date(report.lastDimensionCheck.checkedAt).toLocaleString()}</>}
            </div>
            <Button size="sm" variant="outline" className="h-7" disabled={!report.activeEmbeddingModel || repairing === "dimensions"} onClick={() => void checkDimensions()}>
              {repairing === "dimensions" ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="mr-1 h-3 w-3" />}Verify model dimensions
            </Button>
          </CardContent>
        </Card>
      )}

      {grouped.length === 0 && report && (
        <div className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">No repairable issues found.</div>
      )}
      {grouped.map(([category, issues]) => (
        <Card key={category}>
          <CardHeader className="pb-2"><CardTitle className="capitalize text-sm">{category}</CardTitle></CardHeader>
          <CardContent className="space-y-2 pt-0">
            {issues.map(issue => {
              const Icon = issue.severity === "error" ? AlertCircle : issue.severity === "warning" ? AlertTriangle : Wrench;
              const isOpen = expanded.has(issue.id);
              return (
                <div key={issue.id} className="rounded-md border bg-muted/20 p-3">
                  <div className="flex items-start gap-2">
                    <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", issue.severity === "error" ? "text-destructive" : issue.severity === "warning" ? "text-amber-500" : "text-muted-foreground")} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2"><span className="font-medium text-sm">{issue.title}</span><Badge variant="outline">{issue.count}</Badge></div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{issue.description}</p>
                    </div>
                    {issue.items.length > 0 && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setExpanded(prev => { const next = new Set(prev); next.has(issue.id) ? next.delete(issue.id) : next.add(issue.id); return next; })}>{isOpen ? "Hide" : "Review"}</Button>}
                    {issue.repairAction && <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!repairing} onClick={() => void repair(issue.repairAction!)}>{repairing === issue.repairAction && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{repairLabels[issue.repairAction]}</Button>}
                  </div>
                  {isOpen && issue.items.length > 0 && (
                    <div className="mt-3 max-h-64 space-y-1 overflow-y-auto border-t pt-2">
                      {issue.items.map(item => (
                        <div key={item.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-secondary/60">
                          <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                          {item.detail && <span className="hidden max-w-[45%] truncate font-mono text-[10px] text-muted-foreground sm:block" title={item.detail}>{item.detail}</span>}
                          {item.href && <Link href={item.href}><ExternalLink className="h-3.5 w-3.5 text-muted-foreground" /></Link>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      <BackgroundJobs limit={25} />

      <Card>
        <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2 text-sm"><DatabaseBackup className="h-4 w-4" />Backup and restore</CardTitle></CardHeader>
        <CardContent className="grid gap-5 pt-0 md:grid-cols-2">
          <div className="space-y-2">
            <div className="text-xs font-medium">Create database backup</div>
            <p className="text-[11px] text-muted-foreground">Includes Concord’s database, notes, chats, configuration, and indexes. Large external media files remain in their existing folders.</p>
            <FolderInput value={backupFolder} onChange={setBackupFolder} prompt="Choose Concord backup folder" placeholder="Backup destination folder" className="h-8 text-xs" />
            <Button size="sm" onClick={() => void createBackup()} disabled={!backupFolder.trim() || backupBusy}>{backupBusy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Create backup</Button>
          </div>
          <div className="space-y-2 border-t pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
            <div className="text-xs font-medium">Restore from backup</div>
            <p className="text-[11px] text-muted-foreground">The backup is validated and staged. It is applied only after restart, while your current database is retained as a recoverable pre-restore copy.</p>
            <FileInput value={restoreFile} onChange={setRestoreFile} prompt="Choose Concord database backup" placeholder="Path to .sqlite backup" className="h-8 text-xs" />
            <Button size="sm" variant="outline" onClick={() => void restore()} disabled={!restoreFile.trim() || backupBusy}><ArchiveRestore className="mr-1 h-3.5 w-3.5" />Validate and restore…</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
