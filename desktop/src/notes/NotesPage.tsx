import { useEffect, useState } from "react";
import { NotebookPen, Plus, Search } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock, count } from "../lib/format.ts";
import type { Note } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";

const created = (s?: string) => (s ? s.slice(0, 10) : "");

export function NotesPage() {
  const { revision, openNote } = useApp();
  const toast = useToast();
  const [notes, setNotes] = useState<Note[]>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    api
      .research()
      .then((r) => setNotes(r.notes))
      .catch(toast.error);
  }, [revision, toast]);
  const q = query.trim().toLowerCase();
  const shown = (notes ?? []).filter((n) => !q || [n.title, n.body, n.quote ?? "", n.media_title ?? ""].some((s) => s.toLowerCase().includes(q)));
  return (
    <div className="notes-page">
      <PageHeader
        title="Notes"
        meta={notes ? count(notes.length, "note") : "Loading…"}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => openNote({ title: "", body: "" })}>
            New note
          </Button>
        }
      />
      {notes && notes.length > 0 && (
        <label className="search-field notes-filter">
          <Search size={15} aria-hidden />
          <input type="search" aria-label="Filter notes" placeholder="Filter notes…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      <ul className="note-list">
        {shown.map((n) => (
          <li key={n.id}>
            <button type="button" className="note-row" onClick={() => openNote(n)}>
              <span className="note-row-main">
                <b className="note-row-title">{n.title}</b>
                {(n.body || n.quote) && <span className="note-row-snippet">{n.body || `“${n.quote}”`}</span>}
              </span>
              <span className="note-row-side">
                {n.media_id && n.start != null && (
                  <Chip tone="accent" title={n.media_title ?? undefined}>
                    <span className="note-row-source">{n.media_title ?? "Recording"}</span> · {clock(n.start)}
                  </Chip>
                )}
                <span className="note-row-date num">{created(n.created_at)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {notes && !notes.length && (
        <Empty icon={NotebookPen} title="A place to think" text="Save a passage from a transcript, or start a note here." />
      )}
      {notes && notes.length > 0 && !shown.length && <Empty icon={Search} title="No notes match" text="Try a different word." />}
    </div>
  );
}
