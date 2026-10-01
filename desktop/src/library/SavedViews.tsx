import { useState } from "react";
import { Bookmark, Save, Trash2 } from "lucide-react";
import type { LibraryFilter } from "../lib/types.ts";
import { useStoredState } from "../lib/storage.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { normalizeFilter, readViews, viewKey, type SavedView } from "./model.ts";

export function SavedViews({ filter, layout, onApply }: { filter: LibraryFilter; layout: "grid" | "list"; onApply: (view: SavedView) => void }) {
  const [stored, setStored] = useStoredState<unknown>("library-saved-views-v1", []);
  const views = readViews(stored);
  const selected = views.find(v => viewKey(v.filter, v.layout) === viewKey(filter, layout));
  const [open, setOpen] = useState(false), [name, setName] = useState("");
  const toast = useToast();
  const existing = views.find(v => v.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase());
  const save = () => {
    if (!name.trim()) return;
    const view: SavedView = { id: existing?.id ?? crypto.randomUUID(), name: name.trim(), filter: { ...normalizeFilter(filter), offset: 0 }, layout };
    setStored([...views.filter(v => v.id !== view.id), view]);
    setOpen(false); toast.success(existing ? "Saved view updated" : "View saved");
  };
  return <div className="library-saved-views">
    <Bookmark size={15}/>
    <Select label="Saved library views" size="sm" value={selected?.id ?? ""} onChange={id => { const v = views.find(v => v.id === id); if (v) onApply(v); }} options={[{ value: "", label: "Current view" }, ...views.map(v => ({ value: v.id, label: v.name }))]}/>
    <Button size="sm" variant="ghost" icon={Save} onClick={() => { setName(selected?.name ?? ""); setOpen(true); }}>Save view</Button>
    {!!views.length && <Button size="sm" variant="ghost" onClick={() => { setName(""); setOpen(true); }}>Manage views</Button>}
    <Dialog open={open} onOpenChange={setOpen} title="Saved library views" description="Save the current search, filters, category, sort order, and grid or list layout." footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Close</Button><Button variant="primary" disabled={!name.trim() || (!existing && views.length >= 100)} onClick={save}>{existing ? "Update saved view" : "Save current view"}</Button></>}>
      <label className="field">View name<input aria-label="View name" maxLength={80} value={name} onChange={e => setName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === "Enter" && name.trim() && (existing || views.length < 100)) save(); }}/></label>
      <div className="saved-views-list">{views.map(v => <div key={v.id}><button onClick={() => { onApply(v); setOpen(false); }}>{v.name}<small>{v.filter.category === "work" ? "Work" : v.filter.category === "personal" ? "Personal" : "Personal + Work"}{v.filter.channel && ` · ${v.filter.channel}`}</small></button><IconButton label={`Delete saved view ${v.name}`} icon={Trash2} size="sm" onClick={() => setStored(views.filter(other => other.id !== v.id))}/></div>)}</div>
    </Dialog>
  </div>;
}
