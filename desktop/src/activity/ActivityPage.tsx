import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, CircleAlert, Clock, Folder, HeartPulse, LoaderCircle, Pause, Play, RefreshCw, Rss, X } from "lucide-react";
import { AskHelp } from "../ai/ConcordHelp.tsx";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import { checkedAgo, isFollowed } from "../library/following.ts";
import { AutomaticQueue } from "../pipeline/AutomaticAi.tsx";
import { isPending, type AutomaticAi, type PipelineState, type QueueJob, type Source } from "../pipeline/types.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { activityHeadline, jobLine } from "./model.ts";
import "../pipeline/pipeline.css";
import "./activity.css";

const UP_NEXT = 8;
const STUCK = ["failed", "interrupted"];

/** What is running, what needs you, what is next, and what Concord is following. Replaces the Pipeline page. */
export function ActivityPage() {
  const { navigate, refresh, openActivity, setup } = useApp();
  const toast = useToast();
  const [state, setState] = useState<PipelineState>();
  const [automatic, setAutomatic] = useState<AutomaticAi>();
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const [allNext, setAllNext] = useState(false);
  const [removing, setRemoving] = useState<QueueJob | null>(null);
  const load = useCallback(async () => {
    const [next, ai] = await Promise.all([api.pipelineState(), api.pipelineAiState()]);
    setState(next);
    setAutomatic(ai);
  }, []);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        if (alive) await load();
      } catch (e) {
        if (alive) toast.error(e);
      }
      if (alive) timer = window.setTimeout(poll, 1500);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load, toast]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      await load();
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const act = (action: string, id?: string) => run(() => api.pipelineAction(action, id));

  const jobs = state?.jobs ?? [];
  const now = jobs.filter((j) => j.status === "running");
  const stuck = jobs.filter((j) => STUCK.includes(j.status));
  const next = jobs.filter((j) => isPending(j.status) && j.status !== "running");
  const done = jobs.filter((j) => ["complete", "cancelled"].includes(j.status));
  const today = new Date().toDateString();
  const finishedToday = jobs.filter((j) => j.status === "complete" && j.finished_at && new Date(j.finished_at).toDateString() === today).length;
  const sources = (state?.sources ?? []).filter((s) => s.kind !== "collection" && (isFollowed(s) || s.enabled === 1));
  const paused = state ? !state.running : false;
  const speechMissing = setup && !setup.speech.installed;

  const open = (j: QueueJob) => navigate({ page: "recording", id: j.media_id });
  const title = (j: QueueJob) => (
    <button type="button" className="activity-title" onClick={() => open(j)}>
      {j.title}
      <ArrowUpRight size={13} aria-hidden />
    </button>
  );

  return (
    <div className="activity-page">
      <PageHeader
        title="Activity"
        meta={state ? activityHeadline(state.overview) : "Loading…"}
        actions={
          state &&
          (paused ? (
            <Button variant="primary" icon={Play} disabled={busy} onClick={() => void act("start")}>
              Resume
            </Button>
          ) : (
            <Button icon={Pause} disabled={busy} onClick={() => void act("pause")}>
              Pause
            </Button>
          ))
        }
      />

      {paused && (now.length > 0 || next.length > 0) && (
        <p className="activity-notice">
          <Pause size={15} aria-hidden />
          {now.length ? "What's running now finishes; nothing new starts until you resume." : "Nothing new starts until you resume."}
        </p>
      )}
      {speechMissing && next.some((j) => j.kind === "transcribe" || j.path) && (
        <p className="activity-notice">
          <CircleAlert size={15} aria-hidden />
          <span>Transcription waits for the speech engine. </span>
          <Button size="sm" onClick={() => navigate({ page: "setup", step: "speech", returnTo: "library" })}>
            Install it
          </Button>
        </p>
      )}
      {state?.previewing && <p className="activity-notice">Live transcription in Tools is using speech processing. Recordings wait until it stops.</p>}
      {state?.overview.atDailyLimit && (
        <p className="activity-notice">
          Today's download limit is reached ({state.overview.dailyDownloads} of {state.overview.dailyLimit}). Downloads continue after midnight; local recordings still transcribe.
        </p>
      )}

      <section className="activity-section" aria-label="Now">
        <h2>Now</h2>
        {now.length ? (
          <div className="activity-card">
            {now.map((j) => {
              const line = jobLine(j);
              return (
                <article key={j.id} className="activity-now">
                  <div className="activity-now-head">
                    <LoaderCircle size={16} className="spin" aria-hidden />
                    {title(j)}
                    <span className="activity-state">{paused ? `Pausing after this · ${line.label}` : line.label}</span>
                    <IconButton size="sm" icon={X} label={`Stop ${j.title}`} disabled={busy || j.cancelled === 1} onClick={() => void act("cancel", j.id)} />
                  </div>
                  <span className="activity-bar" aria-hidden>
                    <span className={line.pct == null ? "is-indeterminate" : undefined} style={line.pct == null ? undefined : { width: `${line.pct}%` }} />
                  </span>
                  <small>{j.kind === "download" && !j.path ? `Downloading from ${j.channel}` : j.message || "Transcribing and identifying speakers"}</small>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="activity-empty">{next.length && !paused ? "Starting the next recording…" : "Nothing is running."}</p>
        )}
      </section>

      {stuck.length > 0 && (
        <section className="activity-section" aria-label="Needs attention">
          <h2>Needs attention · {stuck.length}</h2>
          <div className="activity-card">
            {stuck.map((j) => (
              <article key={j.id} className="activity-stuck">
                <CircleAlert size={16} aria-hidden className="activity-stuck-icon" />
                <div className="activity-stuck-text">
                  {title(j)}
                  <small>{j.message || "This recording couldn't be processed."}</small>
                </div>
                <div className="activity-actions">
                  <Button size="sm" icon={RefreshCw} disabled={busy} onClick={() => void act("retry", j.id)}>
                    Retry
                  </Button>
                  <AskHelp topic="queue" error={j.message} />
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemoving(j)}>
                    Remove
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="activity-columns">
        <section className="activity-section" aria-label="Up next">
          <div className="activity-section-head">
            <h2>Up next{next.length ? ` · ${next.length}` : ""}</h2>
            {next.length > 1 && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel-pending")}>
                Clear all
              </Button>
            )}
          </div>
          {next.length ? (
            <div className="activity-card activity-list">
              {(allNext ? next : next.slice(0, UP_NEXT)).map((j) => (
                <div key={j.id} className="activity-row">
                  {title(j)}
                  <span className="activity-state">{jobLine(j).label}</span>
                  <IconButton size="sm" icon={X} label={`Remove ${j.title} from the queue`} disabled={busy || j.cancelled === 1} onClick={() => void act("cancel", j.id)} />
                </div>
              ))}
              {next.length > UP_NEXT && (
                <button type="button" className="activity-more" onClick={() => setAllNext((v) => !v)}>
                  {allNext ? "Show fewer" : `Show ${next.length - UP_NEXT} more`}
                </button>
              )}
            </div>
          ) : (
            <p className="activity-empty">Nothing waiting. Add recordings and they're transcribed one after another.</p>
          )}
        </section>

        <section className="activity-section" aria-label="Following">
          <h2>Following</h2>
          {sources.length ? (
            <div className="activity-card activity-list">
              {sources.map((s) => (
                <FollowingRow key={s.id} source={s} busy={busy} onOpen={() => navigate({ page: "library", collection: s.id })} onCheck={() => void run(() => api.pipelineCheck(s.id))} onFollow={() => void run(() => api.addFollow(s.url, s.name, s.category, s.diarize === 1, s.include_shorts === 1))} />
              ))}
            </div>
          ) : (
            <p className="activity-empty">Follow a channel or watch a folder from Add, and it's checked for new recordings here.</p>
          )}
        </section>
      </div>

      {automatic && <AutomaticQueue state={automatic} onChanged={load} />}

      <footer className="activity-foot">
        <HeartPulse size={16} aria-hidden />
        <span>{finishedToday ? `${count(finishedToday, "recording")} finished today` : "Nothing finished yet today"}</span>
        <span className="spacer" />
        <Button size="sm" variant="ghost" icon={Clock} onClick={() => setHistory((v) => !v)}>
          {history ? "Hide history" : `History (${done.length})`}
        </Button>
        <Button size="sm" variant="ghost" onClick={openActivity}>
          Health &amp; repair
        </Button>
      </footer>
      {history && (
        <section className="activity-section" aria-label="History">
          <div className="activity-section-head">
            <h2>History</h2>
            {done.length > 0 && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("clear")}>
                Clear history
              </Button>
            )}
          </div>
          {done.length ? (
            <div className="activity-card activity-list">
              {done
                .slice()
                .reverse()
                .map((j) => (
                  <div key={j.id} className="activity-row">
                    {title(j)}
                    <span className="activity-state">{j.status === "complete" ? "Transcribed" : "Cancelled"}</span>
                  </div>
                ))}
            </div>
          ) : (
            <p className="activity-empty">No finished work yet.</p>
          )}
        </section>
      )}
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.title ?? "this recording"} from your library?`}
        body="Its transcript and notes are removed from Concord. The original file is kept."
        confirmLabel="Remove"
        danger
        onConfirm={() => {
          const j = removing;
          if (j) void run(() => api.removeRecording(j.media_id));
        }}
      />
    </div>
  );
}

function FollowingRow({ source: s, busy, onOpen, onCheck, onFollow }: { source: Source; busy: boolean; onOpen: () => void; onCheck: () => void; onFollow: () => void }) {
  const Icon = s.kind === "folder" ? Folder : Rss;
  const checking = s.check_status === "checking";
  const legacy = !isFollowed(s);
  const failed = !!s.check_status && !["complete", "interrupted", "checking"].includes(s.check_status);
  return (
    <div className="activity-row activity-following">
      <Icon size={15} aria-hidden className="activity-following-icon" />
      <button type="button" className="activity-title" onClick={onOpen}>
        {s.name}
      </button>
      <small className={failed ? "activity-following-failed" : undefined}>
        {legacy && s.kind === "youtube" ? "Older subscription" : checking ? "Checking now…" : failed ? s.check_message || "Last check failed" : checkedAgo(s.last_check)}
      </small>
      {legacy && s.kind === "youtube" ? (
        <Button size="sm" disabled={busy} onClick={onFollow}>
          Follow for new videos
        </Button>
      ) : (
        <IconButton size="sm" icon={RefreshCw} label={`Check ${s.name} now`} disabled={busy || checking} onClick={onCheck} />
      )}
    </div>
  );
}
