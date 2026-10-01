import { useState } from "react";
import { api } from "../lib/ipc.ts";
import type { NoteLink, Research } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { LINK_KINDS } from "./model.ts";
export function NoteLinks({id,data,onSelect}: {id:string;data:Research;onSelect?:(id:string)=>void}) {
  const {refresh}=useApp();const toast=useToast();const [target,setTarget]=useState("");const [kind,setKind]=useState("same_topic");const [reason,setReason]=useState("");const [editing,setEditing]=useState<NoteLink>();const [busy,setBusy]=useState(false);
  const links=data.links.filter(l=>l.source===id||l.target===id);
  const save=async()=>{setBusy(true);try{
    const next={...(editing??{}),source:editing?.source??id,target:editing?.target??target,kind,note:reason};
    await api.setNoteLink(next);if(editing&&editing.kind!==kind)await api.setNoteLink(editing,true);
    setTarget("");setReason("");setEditing(undefined);refresh();
  }catch(e){toast.error(e);}finally{setBusy(false);}};
  const remove=async(l:NoteLink)=>{try{await api.setNoteLink(l,true);refresh();}catch(e){toast.error(e);}};
  return <section className="note-links"><h3>Connections</h3><ul>{links.map((l,i)=>{const other=l.source===id?l.target:l.source;return <li key={`${l.source}|${l.target}|${l.kind}|${i}`}>
    <span>{LINK_KINDS.find(k=>k.value===l.kind)?.label??l.kind} · </span><button onClick={()=>onSelect?.(other)}>{data.notes.find(n=>n.id===other)?.title??"Note"}</button>
    {l.note&&<p className="muted">{l.note}</p>}<Button size="sm" variant="ghost" onClick={()=>{setEditing(l);setTarget(other);setKind(l.kind);setReason(l.note??"");}}>Edit</Button>
    <Button size="sm" variant="ghost" onClick={()=>void remove(l)}>Remove</Button></li>;})}</ul>
    <div className="note-link-form"><Select label="Connection type" value={kind} onChange={setKind} options={LINK_KINDS} />
      {!editing&&<Select label="Connect to note" value={target} onChange={setTarget} options={[{value:"",label:"Choose a note…"},...data.notes.filter(n=>n.id!==id).map(n=>({value:n.id!,label:n.title}))]} />}
      <input aria-label="Connection explanation" placeholder="Why are these connected? (optional)" value={reason} onChange={e=>setReason(e.target.value)} />
      <Button size="sm" disabled={busy||(!target&&!editing)} onClick={()=>void save()}>{editing?"Save connection":"Connect"}</Button>
      {editing&&<Button size="sm" variant="ghost" onClick={()=>{setEditing(undefined);setTarget("");}}>Cancel edit</Button>}</div>
  </section>;
}
