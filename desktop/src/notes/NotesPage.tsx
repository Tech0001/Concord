import { useEffect, useState } from "react";
import { NotebookPen, Plus, Search } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock, count } from "../lib/format.ts";
import type { Research } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Select } from "../ui/Select.tsx";
import { Dialog, ConfirmDialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { Markdown } from "../documents/Markdown.tsx";
import { anchorsOf } from "./model.ts";
import { NoteLinks } from "./NoteLinks.tsx";
import "./notes.css";

export function NotesPage() {
  const {revision,openNote,refresh,navigate}=useApp();const toast=useToast();
  const [data,setData]=useState<Research>();const [query,setQuery]=useState("");const [tag,setTag]=useState("");const [sort,setSort]=useState("recent");const [channel,setChannel]=useState("");
  const [selected,setSelected]=useState<string>();const [remove,setRemove]=useState(false);
  const [manage,setManage]=useState(false);const [from,setFrom]=useState("");const [to,setTo]=useState("");const [children,setChildren]=useState(false);const [busy,setBusy]=useState(false);
  useEffect(()=>{let alive=true;api.research().then(r=>alive&&setData(r)).catch(toast.error);return()=>{alive=false;};},[revision,toast]);
  const q=query.trim().toLowerCase();
  const shown=(data?.notes??[]).filter(n=>(!q||[n.title,n.body,...anchorsOf(n).map(a=>`${a.title??""} ${a.quote}`),...(n.tags??[])].some(s=>s.toLowerCase().includes(q)))&&(!tag||n.tags?.includes(tag))&&(!channel||anchorsOf(n).some(a=>a.channel===channel)))
    .sort((a,b)=>sort==="title"?a.title.localeCompare(b.title):sort==="oldest"?(a.created_at??"").localeCompare(b.created_at??""):(b.updated_at??b.created_at??"").localeCompare(a.updated_at??a.created_at??""));
  const active=data?.notes.find(n=>n.id===selected);
  const tags=data?.tags??[];
  const channels=[...new Set((data?.notes??[]).flatMap(n=>anchorsOf(n).flatMap(a=>a.channel?[a.channel]:[])))].sort();
  const rename=async(deleting=false)=>{setBusy(true);try{await api.renameNoteTag(from,deleting?null:to,children);refresh();setManage(false);if(tag===from)setTag(deleting?"":to.trim().toLowerCase());toast.success(deleting?"Tag removed from notes":"Tags renamed or merged");}catch(e){toast.error(e);}finally{setBusy(false);}};
  return <div className="notes-page"><PageHeader title="Notes" meta={data?count(data.notes.length,"note"):"Loading…"} actions={<Button variant="primary" icon={Plus} onClick={()=>openNote({title:"",body:""})}>New note</Button>} />
    <div className="notes-toolbar"><label className="search-field notes-filter"><Search size={15} /><input type="search" aria-label="Filter notes" placeholder="Filter notes and passages…" value={query} onChange={e=>setQuery(e.target.value)} /></label>
      <Select label="Filter by tag" value={tag} onChange={setTag} options={[{value:"",label:"All tags"},...tags.map(t=>({value:t.tag,label:`${t.tag} (${t.count})`}))]} />
      <Select label="Filter by collection" value={channel} onChange={setChannel} options={[{value:"",label:"All collections"},...channels.map(c=>({value:c,label:c}))]} />
      <Select label="Sort notes" value={sort} onChange={setSort} options={[{value:"recent",label:"Recently edited"},{value:"oldest",label:"Oldest first"},{value:"title",label:"Title"}]} />
      {!!tags.length&&<Button size="sm" variant="ghost" onClick={()=>{setFrom(tag||tags[0].tag);setTo("");setManage(true);}}>Manage tags</Button>}</div>
    <div className="notes-split"><ul className="note-list">{shown.map(n=><li key={n.id}><button className={`note-row ${selected===n.id?"is-selected":""}`} onClick={()=>setSelected(n.id)}>
      <span className="note-row-main"><b className="note-row-title">{n.title}</b><span className="note-row-snippet">{n.body||anchorsOf(n)[0]?.quote}</span>
      <span className="note-tags">{n.tags?.map(t=><Chip key={t}>{t}</Chip>)}</span></span>
      <span className="note-row-side"><span className="muted">{count(anchorsOf(n).length,"source")}</span><span className="note-row-date">{n.created_at?.slice(0,10)}</span></span>
    </button></li>)}</ul>
    {active&&data&&<aside className="note-detail" aria-label="Note details"><header><h2>{active.title}</h2><Button size="sm" onClick={()=>openNote(active)}>Edit note</Button><Button size="sm" variant="ghost" onClick={()=>setRemove(true)}>Delete</Button></header>
      {active.body&&<Markdown source={active.body} />}
      <div className="note-tags">{active.tags?.map(t=><button key={t} onClick={()=>setTag(t)}><Chip>{t}</Chip></button>)}</div>
      <h3>Evidence</h3>{anchorsOf(active).map((a,i)=><section className="note-evidence" key={a.id??i}>
        <button className="evidence-source" onClick={()=>a.media_id?navigate({page:"recording",id:a.media_id,at:a.start??0}):a.doc_id&&navigate({page:"documents",id:a.doc_id})}>
          {a.title??(a.media_id?"Recording":"Document")}{a.media_id&&` · ${clock(a.start??0)}–${clock(a.end??a.start??0)}`}</button>
        {a.quote&&<blockquote className="note-quote">{a.quote}</blockquote>}</section>)}
      {!anchorsOf(active).length&&<p className="muted">A standalone thought. Add evidence when you edit the note.</p>}
      <NoteLinks key={active.id} id={active.id!} data={data} onSelect={setSelected} />
    </aside>}</div>
    {data&&!shown.length&&<Empty icon={data.notes.length?Search:NotebookPen} title={data.notes.length?"No notes match":"A place to think"} text="Save a passage from a transcript or document, or start a note here." />}
    <ConfirmDialog open={remove} onOpenChange={setRemove} title="Delete this note?" body="Its tags and connections will also be removed. Your recordings and documents stay in the library." confirmLabel="Delete note" danger onConfirm={()=>{if(active?.id)void api.deleteNote(active.id).then(()=>{setSelected(undefined);refresh();}).catch(toast.error);}} />
    <Dialog open={manage} onOpenChange={setManage} title="Manage tags" footer={<><Button variant="ghost" disabled={busy||!from} onClick={()=>void rename(true)}>Remove tag</Button><Button disabled={busy||!from||!to.trim()} onClick={()=>void rename()}>Rename or merge</Button></>}>
      <Select label="Existing tag" value={from} onChange={setFrom} options={tags.map(t=>({value:t.tag,label:t.tag}))} />
      <label className="field">New name<input value={to} onChange={e=>setTo(e.target.value)} placeholder="An existing tag merges them" /></label>
      <label className="voice-check"><input type="checkbox" checked={children} onChange={e=>setChildren(e.target.checked)} />Include child tags (tag.subtopic)</label>
    </Dialog>
  </div>;
}
