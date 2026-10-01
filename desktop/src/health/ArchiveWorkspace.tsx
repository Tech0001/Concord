import { AskHelp } from "../ai/ConcordHelp.tsx";
import { SetupChecklist } from "../setup/SetupChecklist.tsx";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  DatabaseBackup,
  HeartPulse,
  RefreshCw,
  Square,
  TerminalSquare,
  FolderOpen,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { Runtime } from "../lib/types.ts";
import type {
  ArchiveStatus,
  Audit,
  BackupValidation,
  Coverage,
  HealthIssue,
  HealthItem,
  MaintenanceJob,
} from "./types.ts";
import { Terminal } from "./Terminal.tsx";
import "./health.css";
const number = (n: number) => n.toLocaleString();
const bytes = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : `${number(n)} B`;
const when = (s: string) => new Date(Number(s)).toLocaleString();
const labels: Record<string, string> = {
  reindex: "Rebuild search index",
  thumbnails: "Generate missing thumbnails",
  fingerprints: "Scan media fingerprints",
  cleanup: "Clean derived indexes",
  "embed-recordings": "Embed missing transcripts",
  "embed-documents": "Embed missing documents",
};
function CoverageCard({
  title,
  value,
  detail,
  action,
}: {
  title: string;
  value: Coverage;
  detail?: string;
  action?: ReactNode;
}) {
  const pct = value.total ? Math.round((value.covered / value.total) * 100) : 0,
    missing = Math.max(0, value.total - value.covered);
  return (
    <section className="archive-coverage">
      <h3>{title}</h3>
      <div className="coverage-numbers">
        <strong>{number(value.covered)}</strong>
        <span>/ {number(value.total)}</span>
        <small>{value.total ? `${pct}%` : "—"}</small>
      </div>
      <progress
        max={value.total || 1}
        value={value.covered}
        aria-label={`${title} coverage`}
      />
      <p>
        {missing
          ? `${number(missing)} missing`
          : value.total
            ? "All caught up"
            : "No applicable sources"}
      </p>
      {detail && <p className="muted">{detail}</p>}
      {action}
    </section>
  );
}
function Jobs({
  onHelp,
  jobs,
  aiJobs,
  onChange,
}: {
  onHelp: () => void;
  jobs: MaintenanceJob[];
  aiJobs: MaintenanceJob[];
  onChange: () => void;
}) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const all = [
    ...jobs.map((j) => ({
      ...j,
      type: j.action === "summary" ? "summary" : "repair",
    })),
    ...aiJobs.map((j) => ({ ...j, type: "index" })),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const running = all.filter((j) => j.status === "running"),
    finished = all.filter((j) => j.status !== "running");
  const row = (j: MaintenanceJob & { type: string }) => (
    <li key={j.id}>
      <header>
        <strong>
          {j.type === "summary"
            ? `Recording summary · ${j.title}`
            : j.type === "index"
              ? "Semantic search index"
              : labels[j.action] || j.action}
        </strong>
        <span className={`job-status status-${j.status}`}>
          {j.status === "complete" ? "Completed" : j.status}
        </span>
      </header>
      <progress max={j.total || 1} value={j.done} />
      <p>
        {j.done} / {j.total} · {j.message}
      </p>
      {["failed","interrupted"].includes(j.status) && <AskHelp topic={j.type === "index" ? "index" : "health"} error={j.message} onNavigate={onHelp} />}
      {j.status === "running" && (
        <Button
          size="sm"
          icon={Square}
          onClick={() =>
            void (
              j.type === "summary"
                ? api.aiCancelSummary(j.media_id!)
                : j.type === "index"
                  ? api.aiCancelIndex()
                  : api.archiveCancelRepair()
            )
              .then(onChange)
              .catch(toast.error)
          }
        >
          Stop
        </Button>
      )}
      {["failed", "interrupted", "cancelled"].includes(j.status) && (
        <Button
          size="sm"
          disabled={all.some((other) => other.status === "running")}
          onClick={() =>
            void (
              j.type === "summary"
                ? api.aiStartSummary(j.media_id!)
                : j.type === "index"
                  ? j.scope === "document"
                    ? api.archiveRepair("embed-documents")
                    : j.scope === "recording"
                      ? api.archiveRepair("embed-recordings")
                      : api.aiIndex()
                  : api.archiveRepair(j.action)
            )
              .then(onChange)
              .catch(toast.error)
          }
        >
          {j.type === "summary"
            ? "Generate again"
            : j.status === "failed"
              ? "Retry unfinished items"
              : "Resume"}
        </Button>
      )}
      {j.failed && j.details && j.details !== "[]" ? (
        <details>
          <summary>{j.failed} failed items</summary>
          <pre>
            {(() => {
              try {
                return JSON.parse(j.details)
                  .map(
                    (d: { title: string; error: string }) =>
                      `${d.title}: ${d.error}`,
                  )
                  .join("\n");
              } catch {
                return "See the application log for details.";
              }
            })()}
          </pre>
        </details>
      ) : null}
    </li>
  );
  return (
    <section className="archive-section durable-jobs">
      <h3>Durable background jobs</h3>
      {running.length ? (
        <ul>{running.map(row)}</ul>
      ) : (
        <p className="muted">No background AI or repair jobs running.</p>
      )}
      {!!finished.length && (
        <>
          <button
            className="history-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            Recent jobs · {finished.length} finished attempts
          </button>
          {expanded && <ul>{finished.map(row)}</ul>}
        </>
      )}
    </section>
  );
}
export function ArchiveWorkspace({
  activities,
  runtime,
  version,
  onCheck,
  onClose,
}: {
  activities: ReactNode;
  runtime?: Runtime;
  version: string;
  onCheck: () => void;
  onClose: () => void;
}) {
  const toast = useToast(),
    { navigate, openNote } = useApp();
  const [tab, setTab] = useState<"status" | "health" | "activity" | "terminal">(
    "status",
  );
  const [status, setStatus] = useState<ArchiveStatus>();
  const [audit, setAudit] = useState<Audit | null>();
  const [busy, setBusy] = useState("");
  const [issue, setIssue] = useState<HealthIssue>();
  const [reviewQuery, setReviewQuery] = useState("");
  const [jobs, setJobs] = useState<{
    jobs: MaintenanceJob[];
    aiJobs: MaintenanceJob[];
  }>({ jobs: [], aiJobs: [] });
  const [folder, setFolder] = useState(""),
    [restore, setRestore] = useState(""),
    [validation, setValidation] = useState<BackupValidation>();
  const [backupResult, setBackupResult] = useState<{
    path: string;
    bytes: number;
  }>();
  const [verified, setVerified] = useState("");
  const reload = useCallback(async () => {
    const value = await api.archiveStatus();
    setStatus(value);
    setJobs({ jobs: value.jobs, aiJobs: value.aiJobs });
  }, []);
  useEffect(() => {
    void reload().catch(toast.error);
    void api.archiveLastAudit().then(setAudit).catch(toast.error);
    const timer = setInterval(() => void reload().catch(toast.error), 300000);
    return () => clearInterval(timer);
  }, [reload, toast]);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const result = await api.archiveJobs();
        if (alive) setJobs(result);
      } catch (e) {
        if (alive) toast.error(e);
      }
      if (alive) timer = window.setTimeout(poll, 2500);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [toast]);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy("");
    }
  };
  const scan = () =>
    run("audit", async () => {
      setAudit(await api.archiveAudit());
      await reload();
    });
  const repair = (action: string) =>
    run(action, async () => {
      await api.archiveRepair(action);
      setJobs(await api.archiveJobs());
      toast.success("Background repair started");
    });
  const openItem = async (item: HealthItem) => {
    onClose();
    if (item.kind === "recording") navigate({ page: "recording", id: item.id });
    else if (item.kind === "document")
      navigate({ page: "documents", id: item.id });
    else if (item.kind === "note") {
      const data = await api.research();
      const note = data.notes.find((n) => n.id === item.id);
      if (note) openNote(note);
    }
    setIssue(undefined);
  };
  const linked = (
    page: "ai" | "speakers" | "documents" | "pipeline",
    text: string,
  ) => (
    <Button
      size="sm"
      onClick={() => {
        onClose();
        navigate({ page });
      }}
    >
      {text}
    </Button>
  );
  const repairing = jobs.jobs.some(
      (j) => j.status === "running" && j.action !== "summary",
    ),
    indexing = jobs.aiJobs.some((j) => j.status === "running");
  return (
    <div className="archive-workspace">
      <div className="archive-tabs">
        <Segmented
          label="Status and health sections"
          value={tab}
          onChange={setTab}
          options={[
            { value: "status", label: "Status", icon: Activity },
            { value: "health", label: "Health & repair", icon: HeartPulse },
            { value: "activity", label: "Activity" },
            { value: "terminal", label: "Terminal", icon: TerminalSquare },
          ]}
        />
        <Button
          size="sm"
          icon={RefreshCw}
          disabled={!!busy}
          onClick={() =>
            void run("refresh", async () => {
              await reload();
              onCheck();
            })
          }
        >
          Refresh
        </Button>
      </div>
      <div className="archive-scroll" key={tab}>
        {tab === "status" && <SetupChecklist variant="health" onNavigate={onClose} />}
        {tab === "status" && status && (
          <>
            <div className="archive-intro">
              <p>
                Single-glance view of the archive.{" "}
                {number(status.archive.complete)} recordings complete ·{" "}
                {number(Math.round(status.archive.hours))} h archived.
              </p>
              <span>
                {status.pipeline?.active
                  ? "Pipeline processing"
                  : status.pipeline?.running
                    ? "Pipeline ready"
                    : "Pipeline paused"}{" "}
                · {runtime?.ready ? "Speech ready" : "Speech setup needed"} ·
                Chat {status.chat.configured ? "configured" : "not configured"}
              </span>
            </div>
            <div className="archive-totals">
              {[
                ["Recordings", number(status.archive.total)],
                ["Hours", `${number(Math.round(status.archive.hours))} h`],
                ["Pending", number(status.archive.pending)],
                ["Failed", number(status.archive.failed)],
                ["Speakers", number(status.speakers.total)],
                [
                  "Daily downloads",
                  `${number(status.pipeline?.dailyDownloads ?? 0)} / ${number(status.pipeline?.dailyLimit ?? 200)}`,
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </div>
              ))}
            </div>
            <div className="pipeline-summary">
              <span>
                {number(
                  (status.pipeline?.queued ?? 0) +
                    (status.pipeline?.active ?? 0),
                )}{" "}
                recordings queued · {number(status.pipeline?.retry ?? 0)}{" "}
                waiting to retry · {number(status.pipeline?.failed ?? 0)}{" "}
                processing failures
              </span>
              {linked("pipeline", "Open Pipeline")}
            </div>
            <Jobs {...jobs} onHelp={onClose} onChange={() => void reload().catch(toast.error)} />
            <div className="archive-coverage-grid">
              <CoverageCard
                title="Transcripts"
                value={status.coverage.transcripts}
                detail={`FTS index: ${number(status.coverage.fts.covered)} files · ${number(status.coverage.segments)} passages`}
                action={
                  <Button size="sm" onClick={() => setTab("health")}>
                    Review integrity
                  </Button>
                }
              />
              <CoverageCard
                title={`Semantic index · ${status.embedding.model}`}
                value={status.coverage.embeddings}
                detail="Coverage in the currently selected embedding model."
                action={linked("ai", "Open AI")}
              />
              <CoverageCard
                title="AI summaries"
                value={status.coverage.summaries}
                detail="Saved summaries for complete recordings."
              />
              <CoverageCard
                title="Diarization"
                value={status.coverage.diarization}
                detail={`${number(status.speakers.unidentified)} unidentified voices waiting for names`}
                action={linked("speakers", "Open Speakers")}
              />
              <CoverageCard
                title="Documents with text"
                value={status.coverage.documents}
                detail={`${status.documents.starred} starred · ${status.documents.personal} personal · ${status.documents.work} work`}
                action={linked("documents", "Open Docs")}
              />
              <CoverageCard
                title={`Docs embedded · ${status.embedding.model}`}
                value={status.coverage.documentEmbeddings}
                detail="Empty documents are excluded from embedding coverage."
                action={linked("ai", "Open AI")}
              />
            </div>
            <section className="archive-section">
              <h3>
                Channels & collections ·{" "}
                {status.channels.filter((c) => c.enabled === 1).length} enabled
                / {status.channels.length} total
              </h3>
              <div className="archive-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {[
                        "Channel",
                        "Recordings",
                        "Done",
                        "Pending",
                        "Failed",
                        "Embed",
                        "Summary",
                        "Diarized",
                        "Flags",
                      ].map((x) => (
                        <th key={x}>{x}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {status.channels.map((c) => (
                      <tr key={c.id}>
                        <th>{c.name}</th>
                        {[
                          c.total,
                          c.complete,
                          c.pending,
                          c.failed,
                          c.embedded,
                          c.summarized,
                          c.diarized,
                        ].map((n, i) => (
                          <td key={i}>{number(n)}</td>
                        ))}
                        <td>
                          {[
                            c.enabled === 0 ? "Off" : null,
                            c.diarize ? "diarize" : null,
                            c.include_shorts ? "shorts" : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <small className="muted">
              Updated {when(status.generatedAt)} · refreshes every 5 minutes.
            </small>
          </>
        )}
        {tab === "status" && !status && <p>Reading archive status…</p>}
        {tab === "health" && (
          <>
            <div className="archive-intro">
              <div>
                <h2>Archive Health & Repair</h2>
                <p>
                  Local integrity checks, recoverable repairs, provenance, and
                  database backups.
                </p>
              </div>
              <Button
                icon={HeartPulse}
                disabled={!!busy}
                onClick={() => void scan()}
              >
                {busy === "audit" ? "Auditing…" : "Run audit"}
              </Button>
            </div>
            {audit ? (
              <section
                className={`archive-audit-summary ${audit.errors ? "has-errors" : ""}`}
              >
                <div>
                  <strong>
                    {audit.errors || audit.warnings
                      ? "The archive needs attention"
                      : "Archive checks are healthy"}
                  </strong>
                  <p>
                    {audit.errors} errors · {audit.warnings} warnings · scanned{" "}
                    {when(audit.generatedAt)}
                  </p>
                </div>
                <span>
                  {bytes(audit.databaseBytes)} database ·{" "}
                  {bytes(audit.mediaBytes)} media
                </span>
              </section>
            ) : (
              <p className="muted">
                Run an audit to check local files and indexes. Opening this view
                does not contact any AI provider.
              </p>
            )}
            <section className="archive-section embedding-guard">
              <div>
                <h3>Embedding compatibility guard</h3>
                <p>
                  Index width: {status?.embedding.dimensions ?? "not built"} ·
                  model: {status?.embedding.model ?? "Loading…"}
                </p>
                {verified && <p role="status">{verified}</p>}
              </div>
              <Button
                size="sm"
                disabled={!!busy}
                onClick={() =>
                  void run("verify", async () => {
                    const v = await api.archiveVerifyEmbedding();
                    setVerified(
                      `Verified ${v.dimensions} dimensions · ${when(v.checkedAt)}`,
                    );
                  })
                }
              >
                Verify model dimensions
              </Button>
            </section>
            {audit &&
              [...new Set(audit.issues.map((i) => i.category))].map(
                (category) => (
                  <section
                    className="archive-section health-category"
                    key={category}
                  >
                    <h3>{category}</h3>
                    {audit.issues
                      .filter((i) => i.category === category)
                      .map((i) => (
                        <div
                          className={`health-issue severity-${i.severity}`}
                          key={i.id}
                        >
                          <div>
                            <strong>
                              {i.title}
                              <span className="health-count">
                                {number(i.count)}
                              </span>
                            </strong>
                            <p>{i.description}</p>
                          </div>
                          <div className="health-issue-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setIssue(i);
                                setReviewQuery("");
                              }}
                            >
                              Review
                            </Button>
                            {i.repair && (
                              <Button
                                size="sm"
                                disabled={
                                  !!busy ||
                                  (i.repair.startsWith("embed")
                                    ? indexing
                                    : repairing)
                                }
                                onClick={() => void repair(i.repair!)}
                              >
                                {labels[i.repair]}
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                  </section>
                ),
              )}
            <Jobs {...jobs} onHelp={onClose} onChange={() => void reload().catch(toast.error)} />
            <section className="archive-section">
              <h3>
                <DatabaseBackup size={16} /> Backup and restore
              </h3>
              <div className="archive-backups">
                <div>
                  <h4>Create database backup</h4>
                  <p>
                    Includes recordings’ database records, notes, chats,
                    indexes, and provider configuration (including saved keys).
                    External media and model files stay in their folders.
                  </p>
                  <div className="path-picker">
                    <input
                      aria-label="Backup destination folder"
                      placeholder="Backup destination folder"
                      value={folder}
                      onChange={(e) => setFolder(e.target.value)}
                    />
                    <Button
                      size="sm"
                      icon={FolderOpen}
                      onClick={() =>
                        void api
                          .pickFolder()
                          .then((p) => p && setFolder(p))
                          .catch(toast.error)
                      }
                    >
                      Browse
                    </Button>
                  </div>
                  <Button
                    disabled={!!busy || !folder.trim()}
                    onClick={() =>
                      void run("backup", async () => {
                        const result = await api.archiveCreateBackup(folder);
                        setBackupResult(result);
                        toast.success("Backup created");
                      })
                    }
                  >
                    {busy === "backup" ? "Creating backup…" : "Create backup"}
                  </Button>
                  {backupResult && (
                    <p role="status">
                      {backupResult.path} · {bytes(backupResult.bytes)}{" "}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void api.reveal(backupResult.path).catch(toast.error)
                        }
                      >
                        Show in folder
                      </Button>
                    </p>
                  )}
                </div>
                <div>
                  <h4>Restore from backup</h4>
                  <p>
                    Validate and stage a Concord Next backup. It is applied
                    after restart, with the current database saved as a
                    recoverable copy first.
                  </p>
                  <div className="path-picker">
                    <input
                      aria-label="Backup file to restore"
                      placeholder="Path to .sqlite backup"
                      value={restore}
                      onChange={(e) => setRestore(e.target.value)}
                    />
                    <Button
                      size="sm"
                      icon={FolderOpen}
                      onClick={() =>
                        void api
                          .pickFiles({
                            title: "Choose Concord Next backup",
                            name: "SQLite backup",
                            extensions: ["sqlite", "db"],
                            multiple: false,
                          })
                          .then((p) => p[0] && setRestore(p[0]))
                          .catch(toast.error)
                      }
                    >
                      Browse
                    </Button>
                  </div>
                  <Button
                    disabled={!!busy || !restore.trim()}
                    onClick={() =>
                      void run("validate", async () =>
                        setValidation(await api.archiveValidateBackup(restore)),
                      )
                    }
                  >
                    Validate and restore…
                  </Button>
                  {status?.restorePending && (
                    <p role="status">
                      Restore staged. Restart Concord to apply it.{" "}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run("cancel-restore", async () => {
                            await api.archiveCancelRestore();
                            await reload();
                          })
                        }
                      >
                        Cancel staged restore
                      </Button>
                    </p>
                  )}
                </div>
              </div>
            </section>
          </>
        )}
        {tab === "activity" && (
          <>
            {activities}
            <Jobs {...jobs} onHelp={onClose} onChange={() => void reload().catch(toast.error)} />
          </>
        )}
        {tab === "terminal" && (
          <>
            <Terminal />
            <details className="health-console">
              <summary>Runtime diagnostics · Concord Next {version}</summary>
              <pre>
                {runtime
                  ? [
                      `Device: ${runtime.device}${runtime.gpu ? ` · ${runtime.gpu}` : ""}`,
                      `Speech models: ${runtime.modelsReady ? "available" : "missing"}`,
                      `Voice matching: ${runtime.voiceMatchingReady ? "available" : "missing"}`,
                      `Model: ${runtime.model}`,
                      `Models folder: ${runtime.models}`,
                      `Voice runtime: ${runtime.python}`,
                    ].join("\n")
                  : "Checking runtime…"}
              </pre>
              <Button size="sm" onClick={onCheck}>
                Check runtime
              </Button>
            </details>
          </>
        )}
      </div>
      <Dialog
        open={!!issue}
        onOpenChange={(open) => !open && setIssue(undefined)}
        title={issue?.title ?? "Review archive issue"}
        size="lg"
      >
        <label className="field">
          Filter affected items
          <input
            aria-label="Filter affected items"
            value={reviewQuery}
            onChange={(e) => setReviewQuery(e.target.value)}
          />
        </label>
        <ul className="health-review-list">
          {issue?.items
            .filter((i) =>
              `${i.title} ${i.detail}`
                .toLowerCase()
                .includes(reviewQuery.toLowerCase()),
            )
            .map((i, n) => (
              <li key={`${i.id}:${n}`}>
                <div>
                  <strong>{i.title}</strong>
                  <p>{i.detail}</p>
                </div>
                {["recording", "document", "note"].includes(i.kind) && (
                  <Button
                    size="sm"
                    onClick={() => void openItem(i).catch(toast.error)}
                  >
                    Open
                  </Button>
                )}
              </li>
            ))}
        </ul>
      </Dialog>
      <ConfirmDialog
        open={!!validation}
        onOpenChange={(open) => !open && setValidation(undefined)}
        title="Stage this backup for restore?"
        body={
          validation ? (
            <>
              {validation.recordings} recordings · {validation.notes} notes ·{" "}
              {validation.documents} documents.
              <p>
                It will replace your active library
                {validation.includesConfiguration
                  ? " and provider settings"
                  : ""}{" "}
                after restart. Your current database will be backed up first.
                Media files stay in place.
              </p>
            </>
          ) : null
        }
        confirmLabel="Stage restore"
        onConfirm={() =>
          void run("stage", async () => {
            await api.archiveStageRestore(restore);
            await reload();
            setValidation(undefined);
            toast.success("Restore staged for next restart");
          })
        }
      />
    </div>
  );
}
