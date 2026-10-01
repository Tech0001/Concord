import { useState } from "react";
import { FolderOpen, LoaderCircle, Pencil, Plus, RefreshCw, Rss, Square, Trash2 } from "lucide-react";
import { useApp } from "../shell/AppContext.tsx";
import { api } from "../lib/ipc.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { Empty } from "../ui/Empty.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { Source, SourceInput } from "./types.ts";

const blank = (): SourceInput => ({ name: "", kind: "youtube", url: "", enabled: true, diarize: true, includeShorts: false, category: "personal" });
const inputOf = (s: Source): SourceInput => ({ id: s.id, name: s.name, kind: s.kind, url: s.url, enabled: !!s.enabled, diarize: !!s.diarize, includeShorts: !!s.include_shorts, category: s.category });
export function Sources({ sources, checking, onChanged }: { sources: Source[]; checking: boolean; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const { category } = useApp();
  const [editing, setEditing] = useState<SourceInput>();
  const [removing, setRemoving] = useState<Source>();
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await onChanged(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return <section className="pipeline-sources">
    <div className="pipeline-source-toolbar"><div><h2>Sources</h2><p>Subscriptions and recording folders. Checks add new recordings to the queue; existing files and transcripts are preserved.</p></div><Button icon={Plus} variant="primary" disabled={checking} onClick={() => setEditing({ ...blank(), category: category || "personal" })}>Add source</Button>{checking ? <Button icon={Square} disabled={busy} onClick={() => void run(api.pipelineStopCheck)}>Stop check</Button> : <Button icon={RefreshCw} disabled={busy || !sources.some(s => (!category || s.category === category) && s.enabled && s.kind !== "collection")} onClick={() => void run(() => api.pipelineCheck(undefined, false, category))}>Check enabled sources</Button>}</div>
    {sources.some(s => !category || s.category === category) ? <div className="pipeline-source-list">{sources.filter(s => !category || s.category === category).map(s => <article className="pipeline-source" key={s.id}>
      <div className="pipeline-source-head"><span className="pipeline-source-icon">{s.kind === "youtube" ? <Rss size={18}/> : <FolderOpen size={18}/>}</span><div><h3>{s.name}</h3><small>{s.recordings.toLocaleString()} recordings · {s.category === "work" ? "Work" : "Personal"}{s.diarize ? " · speaker diarization" : " · transcription only"}{!!s.include_shorts && " · Shorts included"}</small></div><Chip>{s.enabled ? s.kind === "collection" ? "Collection" : "Enabled" : "Disabled"}</Chip></div>
      {s.url && <p className="pipeline-source-address">{s.url}</p>}
      <div className="pipeline-source-state" data-failed={s.check_status === "failed"}>{s.check_status === "checking" && <LoaderCircle size={14} className="spin"/>}<span>{s.check_message || (s.kind === "collection" ? "An existing collection. Attach a folder or URL to add a source." : "Ready to check for recordings")}{s.last_check > 0 && <small>Last checked {new Date(s.last_check * 1000).toLocaleString()}</small>}</span></div>
      <div className="pipeline-source-actions">{s.kind !== "collection" && <><Button size="sm" icon={RefreshCw} disabled={busy || checking} onClick={() => void run(() => api.pipelineCheck(s.id, false))}>Check now</Button>{s.kind === "youtube" && <Button size="sm" variant="ghost" disabled={busy || checking} title="Find all recordings in this source and queue those not already in your archive" onClick={() => void run(() => api.pipelineCheck(s.id, true))}>Find full history</Button>}</>}<span/><Button size="sm" variant="ghost" disabled={busy || checking} onClick={() => void run(() => api.pipelineSaveSource({ ...inputOf(s), enabled: !s.enabled }))}>{s.enabled ? "Disable" : "Enable"}</Button><IconButton label={`Edit ${s.name} source`} icon={Pencil} disabled={checking} onClick={() => setEditing(inputOf(s))}/><IconButton label={`Remove ${s.name} source`} icon={Trash2} disabled={checking} onClick={() => setRemoving(s)}/></div>
    </article>)}</div> : <Empty icon={Rss} title="Add a source to grow your archive" text="Subscribe to a YouTube channel or scan a folder of recordings. You can also transcribe files already in the Library."/>}
    {editing && <SourceEditor value={editing} onClose={() => setEditing(undefined)} onSaved={onChanged}/>}
    <ConfirmDialog open={!!removing} onOpenChange={open => !open && setRemoving(undefined)} title="Remove this source?" body="This stops future source checks. Existing recordings, files, transcripts, notes, and queued work stay in your archive." confirmLabel="Remove source" onConfirm={() => { if (removing) void run(() => api.pipelineRemoveSource(removing.id)); }}/>
  </section>;
}
function SourceEditor({ value, onClose, onSaved }: { value: SourceInput; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(value); const [busy, setBusy] = useState(false);const toast = useToast();
  const save = async () => { setBusy(true); try { await api.pipelineSaveSource(form); await onSaved(); onClose(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  const folder = async () => { try { const path = await api.pickFolder("Choose a recording folder"); if (path) setForm(f => ({ ...f, url: path, name: f.name || path.split(/[\\/]/).pop() || "Recordings" })); } catch (e) { toast.error(e); } };
  return <Dialog open onOpenChange={open => !open && onClose()} title={value.id ? "Edit source" : "Add source"} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !form.name.trim() || (form.kind !== "collection" && !form.url.trim())} onClick={() => void save()}>Save source</Button></>}>
    <div className="pipeline-source-form">
      <label>Source type<Select label="Source type" value={form.kind} onChange={kind => setForm(f => ({ ...f, kind, url: "" }))} options={[{ value: "youtube", label: "YouTube channel, playlist or video" }, { value: "folder", label: "Local recording folder" }, ...(value.kind === "collection" ? [{ value: "collection" as const, label: "Existing collection" }] : [])]}/></label>
      <label>Name<input className="input" aria-label="Source name" autoFocus value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}/></label>
      {form.kind !== "collection" && <label>{form.kind === "folder" ? "Recording folder" : "YouTube URL"}<div className="pipeline-path"><input className="input" aria-label="Source address" placeholder={form.kind === "folder" ? "/path/to/recordings" : "https://www.youtube.com/@channel"} value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))}/>{form.kind === "folder" && <Button icon={FolderOpen} onClick={() => void folder()}>Browse</Button>}</div></label>}
      <label>Category<Select label="Source category" value={form.category} onChange={category => setForm(f => ({ ...f, category }))} options={[{ value: "personal", label: "Personal" }, { value: "work", label: "Work" }]}/></label>
      <label className="pipeline-checkbox"><input type="checkbox" checked={form.enabled} onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))}/>Include in automatic source checks</label>
      <label className="pipeline-checkbox"><input type="checkbox" checked={form.diarize} onChange={e => setForm(f => ({ ...f, diarize: e.target.checked }))}/>Identify speakers in new transcripts</label>
      {form.kind === "youtube" && <label className="pipeline-checkbox"><input type="checkbox" checked={form.includeShorts} onChange={e => setForm(f => ({ ...f, includeShorts: e.target.checked }))}/>Include YouTube Shorts</label>}
      <p className="muted">Automatic checks run only when enabled in Pipeline setup and the pipeline is started. Renaming a source or changing its category also updates its recordings.</p>
    </div>
  </Dialog>;
}
