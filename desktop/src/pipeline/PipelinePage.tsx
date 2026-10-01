import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Check, Clock, ListOrdered, LoaderCircle, Pause, Play, RefreshCw, Settings2, Square, Rss, X } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count, clock, prettyDate } from "../lib/format.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { isPending, type Candidates, type PipelineState, type QueueJob } from "./types.ts";
import { Sources } from "./Sources.tsx";
import { Setup } from "./Setup.tsx";
import "./pipeline.css";

const labels: Record<string, string> = { running: "Processing", queued: "Queued", retry: "Waiting to retry", complete: "Done", failed: "Failed", cancelled: "Cancelled", interrupted: "Interrupted", waiting_live: "Waiting for live stream" };
export function PipelinePage() {
  const { navigate, refresh, device, setDevice } = useApp();
  const toast = useToast();
  const [state, setState] = useState<PipelineState>();
  const [tab, setTab] = useState<"queue" | "batch" | "sources" | "setup">("queue");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState(false);
  const reload = useCallback(async () => setState(await api.pipelineState()), []);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try { const next = await api.pipelineState(); if (alive) setState(next); }
      catch (e) { if (alive) toast.error(e); }
      if (alive) timer = window.setTimeout(poll, 1500);
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [toast]);
  const act = async (action: string, id?: string) => {
    setBusy(true);
    try { await api.pipelineAction(action, id); await reload(); refresh(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const active = state?.jobs.find(j => j.status === "running");
  const pending = state?.jobs.filter(j => isPending(j.status)) ?? [];
  const finished = state?.jobs.filter(j => !isPending(j.status)) ?? [];
  const row = (j: QueueJob) => <article className="pipeline-job" key={j.id} data-status={j.status}>
    <div className="pipeline-job-main">
      <button className="pipeline-job-title" onClick={() => navigate({ page: "recording", id: j.media_id })}>{j.title}<ArrowUpRight size={13}/></button>
      <small>{j.channel} · {j.kind === "download" && !j.path ? "Download + " : ""}Nemotron 3.5 · {j.device === "auto" ? "Automatic device" : j.device}{j.attempts > 0 && ` · Attempt ${j.attempts}`}</small>
      <p>{j.message}</p>
      {["retry", "waiting_live"].includes(j.status) && <small>Next attempt {new Date(j.retry_at * 1000).toLocaleString()}</small>}
    </div>
    <div className="pipeline-job-actions">
      <Chip tone={j.status === "complete" ? "success" : j.status === "failed" ? "danger" : j.status === "running" ? "accent" : "neutral"}>{j.status === "running" && <LoaderCircle size={12} className="spin"/>}{labels[j.status] ?? j.status}</Chip>
      {isPending(j.status) ? <IconButton icon={X} label={`Cancel ${j.title}`} disabled={busy || j.cancelled === 1} onClick={() => void act("cancel", j.id)}/> : j.status !== "complete" && <Button size="sm" icon={RefreshCw} disabled={busy} onClick={() => void act("retry", j.id)}>Retry</Button>}
    </div>
  </article>;
  return <div className="pipeline-page">
    <PageHeader title="Pipeline" meta="Choose recordings, process them in order, and keep your archive up to date." actions={<>
      <Chip tone={state?.running ? "accent" : "neutral"}>{active ? "Processing" : state?.running ? "Ready" : "Paused"}</Chip>
      {state?.running ? <Button icon={Pause} disabled={busy} onClick={() => void act("pause")}>Pause queue</Button> : <Button icon={Play} variant="primary" disabled={busy || (!pending.length && !state?.config.automaticChecks)} onClick={() => void act("start")}>Start queue</Button>}
      {active && <Button icon={Square} disabled={busy} onClick={() => void act("stop")}>Stop</Button>}
    </>}/>
    <div className="pipeline-tabs" role="tablist" aria-label="Pipeline views">
      {([ ["queue", "Queue", ListOrdered], ["batch", "Transcribe recordings", RefreshCw], ["sources", "Sources", Rss], ["setup", "Setup", Settings2] ] as const).map(([key, label, Icon]) => <button role="tab" aria-selected={tab === key} key={key} onClick={() => setTab(key)}><Icon size={15}/>{label}</button>)}
    </div>
    {state?.overview.atDailyLimit && <div className="pipeline-summary"><span>Daily download limit reached ({state.overview.dailyDownloads} / {state.overview.dailyLimit}). Downloads resume after local midnight; local transcription can continue.</span></div>}
    {!state ? <p className="muted">Loading pipeline…</p> : tab === "queue" ? <>
      <div className="pipeline-summary"><span>{count(pending.length, "recording")} in the queue</span><small>{active && !state.running ? "Paused after the current recording. Stop cancels the current recording too." : "Work survives restarting Concord. Existing transcripts stay available until replacements are ready."}</small>{pending.some(j => j.status !== "running") && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("cancel-pending")}>Clear pending</Button>}</div>
      <section className="pipeline-jobs" aria-label="Processing queue">{pending.length ? pending.map(row) : <Empty icon={Check} title="Queue is clear" text="Add recordings from your library to transcribe or re-transcribe them." action={<Button onClick={() => setTab("batch")}>Choose recordings</Button>}/>}</section>
      <div className="pipeline-history"><Button variant="ghost" icon={Clock} onClick={() => setHistory(v => !v)}>{history ? "Hide" : "Show"} history ({finished.length})</Button>{history && finished.length > 0 && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act("clear")}>Clear history</Button>}</div>
      {history && <section className="pipeline-jobs" aria-label="Queue history">{finished.slice().reverse().map(row)}</section>}
    </> : tab === "batch" ? <BatchView channels={state.channels.map(c => c.channel)} device={device} onAdded={async () => { await reload(); refresh(); setTab("queue"); }}/>
      : tab === "sources" ? <Sources sources={state.sources} checking={state.checking} onChanged={async () => { await reload(); refresh(); }}/>
      : <Setup config={state.config} device={device} onSave={async value => { await api.pipelineSaveConfig(value); setDevice(value.device); await reload(); }}/>
    }
  </div>;
}

function BatchView({ channels, device, onAdded }: { channels: string[]; device: string; onAdded: () => Promise<void> }) {
  const toast = useToast();
  const [channel, setChannel] = useState("");
  const [query, setQuery] = useState("");
  const [missingOnly, setMissingOnly] = useState(true);
  const [data, setData] = useState<Candidates>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true; setData(undefined); setSelected(new Set());
    const timer = setTimeout(() => api.pipelineCandidates({ channel, query, missingOnly }).then(d => alive && setData(d)).catch(e => alive && toast.error(e)), 180);
    return () => { alive = false; clearTimeout(timer); };
  }, [channel, query, missingOnly, toast]);
  const add = async () => {
    setBusy(true);
    try {
      const result = await api.pipelineEnqueue({ channel, query, missingOnly, device, ids: [...selected] }, false);
      toast.success(`${count(result.added, "recording")} queued${result.unavailable ? ` · ${result.unavailable} unavailable` : ""}${result.alreadyQueued ? ` · ${result.alreadyQueued} already queued` : ""}`);
      await onAdded();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };
  return <section className="pipeline-batch">
    <div className="pipeline-filters">
      <Select label="Batch collection" value={channel} onChange={setChannel} options={[{ value: "", label: "All collections" }, ...channels.map(c => ({ value: c, label: c }))]}/>
      <Select label="Transcription scope" value={missingOnly ? "missing" : "all"} onChange={v => setMissingOnly(v === "missing")} options={[{ value: "missing", label: "Missing transcripts" }, { value: "all", label: "All recordings · re-transcribe existing" }]}/>
      <input className="input" aria-label="Find recordings to transcribe" placeholder="Filter recording titles…" value={query} onChange={e => setQuery(e.target.value)}/>
    </div>
    <div className="pipeline-summary"><div><strong>{data ? `${data.eligible.toLocaleString()} available recordings · ${data.hours.toFixed(1)} hours` : "Finding recordings…"}</strong><p>Choose individual recordings below, or add all matches. Re-transcription preserves the old transcript until success and carries forward confidently matched speaker labels.</p>{!!data?.unavailable && <small>{data.unavailable} unavailable files will be skipped. Reconnect their drive to include them.</small>}{!!data?.alreadyQueued && <small>{data.alreadyQueued} already queued will be skipped.</small>}</div>
      <Button icon={ListOrdered} variant="primary" disabled={busy || !data || data.eligible === 0} onClick={() => void add()}>{busy ? "Adding…" : selected.size ? `Queue selected (${selected.size})` : `Queue all matches (${data?.eligible ?? 0})`}</Button>
    </div>
    <div className="pipeline-candidates" aria-label="Recordings to transcribe">{data?.items.map(m => <label key={m.id} className="pipeline-candidate"><input type="checkbox" checked={selected.has(m.id)} onChange={e => setSelected(old => { const next = new Set(old); e.target.checked ? next.add(m.id) : next.delete(m.id); return next; })}/><div><b>{m.title}</b><small>{m.channel} · {prettyDate(m.date)} · {clock(m.duration)}</small></div></label>)}</div>
    {data?.total === 0 && <Empty icon={Check} title="No matching recordings" text="Choose another collection or include recordings with existing transcripts."/>}
  </section>;
}