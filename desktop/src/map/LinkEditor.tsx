import { useState } from "react";
import type { Note, NoteLink } from "../lib/types.ts";
import { api } from "../lib/ipc.ts";
import { clock } from "../lib/format.ts";
import { anchorsOf, LINK_KINDS } from "../notes/model.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { SIDES } from "./model.ts";
export type LinkDraft = { next: NoteLink; previous?: NoteLink };
export function LinkEditor({
  draft,
  notes,
  onClose,
  onSaved,
}: {
  draft: LinkDraft;
  notes: Note[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [link, setLink] = useState(draft.next),
    [busy, setBusy] = useState(false);
  const toast = useToast();
  const change = (field: keyof NoteLink, value: string) =>
    setLink((old) => ({
      ...old,
      [field]: value,
      ...(field === "source"
        ? { source_anchor: "" }
        : field === "target"
          ? { target_anchor: "" }
          : {}),
    }));
  const save = async (remove = false) => {
    setBusy(true);
    try {
      if (remove && draft.previous) await api.setNoteLink(draft.previous, true);
      else if (draft.previous) await api.replaceNoteLink(draft.previous, link);
      else await api.setNoteLink(link);
      onSaved();
      onClose();
      toast.success(remove ? "Connection removed" : "Connection saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const endpoint = (side: "source" | "target") => {
    const note = notes.find((n) => n.id === link[side]);
    const anchorKey = side === "source" ? "source_anchor" : "target_anchor",
      handleKey = side === "source" ? "source_handle" : "target_handle";
    return (
      <fieldset>
        <legend>{side === "source" ? "From" : "To"}</legend>
        <Select
          label={`${side} note`}
          value={link[side]}
          onChange={(v) => change(side, v)}
          options={[
            { value: "", label: "Choose a note…" },
            ...notes.map((n) => ({ value: n.id!, label: n.title })),
          ]}
        />
        <Select
          label={`${side} passage`}
          value={link[anchorKey] || ""}
          onChange={(v) => change(anchorKey, v)}
          options={[
            { value: "", label: "Whole note" },
            ...(note ? anchorsOf(note) : [])
              .filter((a) => a.id)
              .map((a, i) => ({
                value: a.id!,
                label: `${i + 1}. ${a.title || "Source"}${a.media_id ? ` · ${clock(a.start || 0)}` : ""}`,
              })),
          ]}
        />
        <Select
          label={`${side} handle`}
          value={link[handleKey] || (side === "source" ? "right" : "left")}
          onChange={(v) => change(handleKey, v)}
          options={SIDES.map((s) => ({
            value: s,
            label: s[0].toUpperCase() + s.slice(1),
          }))}
        />
      </fieldset>
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title={draft.previous ? "Edit connection" : "Connect notes"}
      description="Connect whole notes or specific pieces of evidence. Follow-up and Context point from the first note to the second."
      footer={
        <>
          {draft.previous && (
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void save(true)}
            >
              Remove connection
            </Button>
          )}
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={
              busy ||
              !link.source ||
              !link.target ||
              link.source === link.target
            }
            onClick={() => void save()}
          >
            Save connection
          </Button>
        </>
      }
    >
      <div className="map-link-endpoints">
        {endpoint("source")}
        {endpoint("target")}
      </div>
      <label className="field">
        Relationship
        <Select
          label="Connection relationship"
          value={link.kind}
          onChange={(v) => change("kind", v)}
          options={LINK_KINDS}
        />
      </label>
      <label className="field">
        Why are these connected?
        <textarea
          rows={3}
          aria-label="Connection explanation"
          value={link.note || ""}
          onChange={(e) => change("note", e.target.value)}
          placeholder="Optional explanation…"
        />
      </label>
    </Dialog>
  );
}
