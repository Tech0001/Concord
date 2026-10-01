import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ChevronDown, LoaderCircle, Play, Search, Users, RefreshCw } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count, humanDuration, prettyDate } from "../lib/format.ts";
import { speakerColor, voiceLabel } from "../lib/speakers.ts";
import { cx } from "../lib/cx.ts";
import type { Appearance, Speaker } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { NameVoiceDialog } from "../player/NameVoiceDialog.tsx";
import { ColorPicker } from "./ColorPicker.tsx";
import "./speakers.css";

const FIRST_PAGE = 50;
function SpeakerDetail({ speaker, onLabel }: { speaker: Speaker; onLabel: (a: Appearance) => void }) {
  const { navigate, revision } = useApp();
  const toast = useToast();
  const [appearances, setAppearances] = useState<Appearance[]>();
  const [notes, setNotes] = useState(speaker.notes ?? "");
  const [savedNotes, setSavedNotes] = useState(speaker.notes ?? "");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    api.speakerAppearances(speaker.id).then(list => alive && setAppearances(list)).catch(toast.error);
    return () => { alive = false; };
  }, [speaker.id, revision, toast]);
  const groups = useMemo(() => {
    const result = new Map<string, { first: Appearance; voices: Appearance[]; airtime: number }>();
    for (const a of appearances ?? []) {
      const group = result.get(a.media_id);
      if (group) { group.voices.push(a); group.airtime += a.airtime; }
      else result.set(a.media_id, { first: a, voices: [a], airtime: a.airtime });
    }
    return [...result.values()].sort((a,b) => b.airtime-a.airtime);
  }, [appearances]);
  const saveNotes = async () => {
    const next = notes.trim(); if (next === savedNotes) return;
    try { await api.setSpeakerNotes(speaker.id,next); setSavedNotes(next); toast.success("Speaker notes saved"); }
    catch(e) { toast.error(e); }
  };
  return <div className="speaker-detail">
    <label className="field speaker-notes">Notes<textarea rows={2} placeholder="Notes about this speaker (saved when you click away)"
      value={notes} onChange={e => setNotes(e.target.value)} onBlur={() => void saveNotes()} /></label>
    <div className="appearances"><div className="appearances-head"><span className="filter-label">Appearances</span>
      {appearances && <span className="muted num">{count(groups.length,"recording")}</span>}</div>
      {!appearances ? <p className="muted"><LoaderCircle size={14} className="spin" /> Loading…</p> : !groups.length ? <p className="muted">No appearances yet.</p> :
        <ul className="appearance-list">{(showAll ? groups : groups.slice(0,FIRST_PAGE)).map(g => <li key={g.first.media_id}>
          <button type="button" className="appearance-row" onClick={() => navigate({ page:"recording",id:g.first.media_id,at:g.first.start ?? 0 })}>
            <span className="appearance-local mono">{g.voices.length}</span><Play size={12} className="appearance-play" />
            <span className="appearance-title">{g.first.title}</span><span className="appearance-meta">{g.first.channel} · {prettyDate(g.first.date)}</span>
            <Chip>{humanDuration(g.airtime)}</Chip>
          </button>
          <details className="fingerprints"><summary>{count(g.voices.length,"voice fingerprint")}</summary>
            {g.voices.map(a => <div key={a.local_id}><span>{voiceLabel(a.local_id)} · {humanDuration(a.airtime)}</span>
              <Button size="sm" variant="ghost" onClick={() => navigate({page:"recording",id:a.media_id,at:a.start ?? 0})}>Listen</Button>
              <Button size="sm" variant="ghost" onClick={() => onLabel(a)}>Change label</Button></div>)}
          </details>
        </li>)}</ul>}
      {!showAll && groups.length > FIRST_PAGE && <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>Show all {groups.length}</Button>}
    </div>
  </div>;
}

type Action = { kind: "edit" | "merge" | "delete"; speaker: Speaker };
function SpeakerAction({ action, speakers, onClose }: { action: Action; speakers: Speaker[]; onClose: () => void }) {
  const { refresh } = useApp(); const toast = useToast();
  const s = action.speaker;
  const [name,setName] = useState(s.name);
  const [color,setColor] = useState(speakerColor(s.color,s.name));
  const [noise,setNoise] = useState(!!s.is_noise);
  const [target,setTarget] = useState("");
  const [query,setQuery] = useState("");
  const [busy,setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      if (action.kind === "edit") await api.editSpeaker(s.id,name,color,noise);
      else if (action.kind === "merge") await api.mergeSpeakers(s.id,target);
      else await api.deleteSpeaker(s.id);
      refresh(); toast.success(action.kind === "delete" ? "Speaker removed; voice fingerprints kept" : action.kind === "merge" ? "Speaker profiles merged" : "Speaker updated"); onClose();
    } catch(e) { toast.error(e); } finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={v => !v && !busy && onClose()} title={action.kind === "merge" ? `Merge ${s.name} into…` : `${action.kind === "edit" ? "Edit" : "Delete"} ${s.name}`}
    footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button><Button variant={action.kind === "delete" ? "danger" : "primary"}
      disabled={busy || (action.kind === "edit" && !name.trim()) || (action.kind === "merge" && !target)} onClick={() => void submit()}>{action.kind === "edit" ? "Save" : action.kind === "merge" ? "Merge profiles" : "Delete speaker"}</Button></>}>
    {action.kind === "edit" ? <><label className="field">Name<input value={name} onChange={e => setName(e.target.value)} maxLength={200} /></label>
      <ColorPicker value={color} onChange={setColor} /><label className="voice-check"><input type="checkbox" checked={noise} onChange={e => setNoise(e.target.checked)} />Noise / ignore</label></> :
      action.kind === "delete" ? <p>Recordings labelled {s.name} become unidentified again. Their voice fingerprints are kept, so a rescan can match them later.</p> :
      <><p>Recordings and voice fingerprints move to the selected person. Their name, color and notes are kept.</p>
      <label className="field">Find target speaker<input type="search" value={query} onChange={e => setQuery(e.target.value)} /></label>
      <div className="voice-options" role="radiogroup" aria-label="Merge target">{speakers.filter(v => v.id !== s.id && v.name.toLowerCase().includes(query.toLowerCase())).map(v =>
        <button type="button" role="radio" aria-checked={target === v.id} key={v.id} onClick={() => setTarget(v.id)}>{v.name}</button>)}</div></>}
  </Dialog>;
}

export function SpeakersPage() {
  const { revision, refresh, navigate } = useApp(); const toast = useToast();
  const [speakers,setSpeakers] = useState<Speaker[]>(); const [unknown,setUnknown] = useState<Appearance[]>([]);
  const [tab,setTab] = useState<"saved" | "unknown">("saved"); const [query,setQuery] = useState("");
  const [open,setOpen] = useState<string | null>(null); const [action,setAction] = useState<Action | null>(null);
  const [label,setLabel] = useState<{appearance: Appearance; speaker?: Speaker} | null>(null);
  const [busy,setBusy] = useState(false); const [limit,setLimit] = useState(FIRST_PAGE);
  useEffect(() => {
    let alive = true;
    Promise.all([api.speakers(),api.unidentifiedSpeakers()]).then(([s,u]) => { if(alive) { setSpeakers(s); setUnknown(u); } }).catch(toast.error);
    return () => { alive=false; };
  },[revision,toast]);
  const scan = async (id?: string) => {
    setBusy(true);
    try { const r = await api.rescanSpeakers(id); refresh(); toast.success(`Matched ${r.matched} voices in ${r.recordings} recordings`); }
    catch(e) { toast.error(e); } finally { setBusy(false); }
  };
  const shown = (speakers ?? []).filter(s => s.name.toLowerCase().includes(query.trim().toLowerCase()));
  const unknownShown = unknown.filter(a => `${a.title} ${a.channel} ${voiceLabel(a.local_id)}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="speakers-page"><PageHeader title="Speakers" meta={speakers ? `${count(speakers.length,"saved voice")} · ${humanDuration(speakers.reduce((n,s) => n+s.airtime,0))} of speech` : "Loading…"} />
    <div className="speaker-toolbar"><Segmented label="Speaker list" value={tab} onChange={v => {setTab(v);setLimit(FIRST_PAGE);}} options={[{value:"saved",label:`Saved voices (${speakers?.length ?? 0})`},{value:"unknown",label:`Unidentified (${unknown.length})`}]} />
      <Button icon={RefreshCw} disabled={busy || !unknown.length || !speakers?.length} onClick={() => void scan()}>Rescan unidentified</Button></div>
    <label className="search-field speakers-filter"><Search size={15} /><input type="search" aria-label="Find a speaker" placeholder={tab === "saved" ? "Find a speaker…" : "Find an unidentified voice…"} value={query} onChange={e => {setQuery(e.target.value);setLimit(FIRST_PAGE);}} /></label>
    {tab === "saved" ? <ul className="speaker-rows">{shown.map(s => <li key={s.id} className={cx("speaker-item",open === s.id && "is-open",!!s.is_noise && "is-noise")} style={{"--speaker":speakerColor(s.color,s.name)} as CSSProperties}>
      <button type="button" className="speaker-row" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
        <i className="speaker-dot" /><span className="speaker-row-name">{s.name}{!!s.is_noise && <Chip>Noise</Chip>}</span><span className="speaker-row-notes">{s.notes}</span>
        <span className="speaker-row-num num">{humanDuration(s.airtime)}</span><span className="speaker-row-num speaker-row-count num">{count(s.recordings,"recording")}</span><ChevronDown size={16} className="speaker-row-chevron" /></button>
      {open === s.id && <><div className="speaker-actions"><Button size="sm" disabled={busy} onClick={() => void scan(s.id)}>Find matches</Button>
        <Button size="sm" onClick={() => setAction({kind:"edit",speaker:s})}>Edit</Button><Button size="sm" disabled={(speakers?.length ?? 0) < 2} onClick={() => setAction({kind:"merge",speaker:s})}>Merge</Button>
        <Button size="sm" variant="ghost" onClick={() => setAction({kind:"delete",speaker:s})}>Delete</Button></div>
        <SpeakerDetail speaker={s} onLabel={appearance => setLabel({appearance,speaker:s})} /></>}
    </li>)}</ul> : <ul className="speaker-rows">{unknownShown.slice(0,limit).map(a => <li className="unknown-voice" key={`${a.media_id}|${a.local_id}`}>
      <Button size="sm" icon={Play} onClick={() => navigate({page:"recording",id:a.media_id,at:a.start ?? 0})}>Listen</Button>
      <div><strong>{voiceLabel(a.local_id)}</strong><p>{a.title}</p><small className="muted">{a.channel} · {prettyDate(a.date)} · {humanDuration(a.airtime)}</small></div>
      <Button size="sm" onClick={() => setLabel({appearance:a})}>Label</Button></li>)}</ul>}
    {tab === "unknown" && unknownShown.length > limit && <Button onClick={() => setLimit(v => v+FIRST_PAGE)}>Show more voices</Button>}
    {speakers && !(tab === "saved" ? shown.length : unknownShown.length) && <Empty icon={tab === "saved" ? Users : Search} title={query ? "No matches" : tab === "saved" ? "No saved voices yet" : "All voices have labels"} text={tab === "saved" ? "Name a voice in a recording or the Unidentified list." : "New unidentified voices appear here after transcription."} />}
    {action && <SpeakerAction action={action} speakers={speakers ?? []} onClose={() => setAction(null)} />}
    {label && <NameVoiceDialog mediaId={label.appearance.media_id} voice={{local:label.appearance.local_id,locals:[label.appearance.local_id],name:label.speaker?.name ?? voiceLabel(label.appearance.local_id),speakerId:label.speaker?.id ?? null,named:!!label.speaker,color:speakerColor(label.speaker?.color,label.appearance.local_id),airtime:label.appearance.airtime}}
      onClose={() => setLabel(null)} onSaved={refresh} onSample={() => {setLabel(null);navigate({page:"recording",id:label.appearance.media_id,at:label.appearance.start ?? 0});}} />}
  </div>;
}
