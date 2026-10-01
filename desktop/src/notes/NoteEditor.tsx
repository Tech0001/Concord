import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock } from "../lib/format.ts";
import type { Note } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import "./notes.css";

export function NoteEditor({ note, onClose }: { note: Note; onClose: () => void }) {
  const { navigate, refresh } = useApp();
  const toast = useToast();
  const [draft, setDraft] = useState(note);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(note), [note]);
  const save = async (openSource = false) => {
    setSaving(true);
    try {
      await api.saveNote({ ...draft, title: draft.title.trim() });
      toast.success("Note saved");
      refresh();
      if (openSource && draft.media_id)
        navigate({
          page: "recording",
          id: draft.media_id,
          at: draft.start ?? 0,
        });
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={note.id ? "Research note" : "New note"}
      size="lg"
      footer={
        <>
          {draft.media_id && (
            <Button
              variant="ghost"
              icon={Play}
              disabled={!draft.title.trim() || saving}
              onClick={() => void save(true)}
              className="note-source-btn"
            >
              Save & open source
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!draft.title.trim() || saving} onClick={() => void save()}>
            Save note
          </Button>
        </>
      }
    >
      <div className="note-editor">
        <input
          className="note-title-input"
          aria-label="Note title"
          placeholder="Give this thought a title"
          autoFocus
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
        {draft.start != null && draft.media_id && (
          <div className="note-range">
            <Chip tone="accent">
              {clock(draft.start)}
              {draft.end != null && ` – ${clock(draft.end)}`}
            </Chip>
            {draft.media_title && <span className="muted">{draft.media_title}</span>}
          </div>
        )}
        {draft.quote && <blockquote className="note-quote">{draft.quote}</blockquote>}
        <textarea
          className="note-body-input"
          aria-label="Note"
          placeholder="What stands out to you?"
          rows={8}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
        />
      </div>
    </Dialog>
  );
}
