import { useEffect, useId, useState } from "react";
import { Play, Plus, X } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock } from "../lib/format.ts";
import type {
  Note,
  NoteAnchor,
  PaletteResults,
  Research,
} from "../lib/types.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Dialog, ConfirmDialog } from "../ui/Dialog.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { chatReady } from "../ai/types.ts";
import { anchorsOf, tagList } from "./model.ts";
import "./notes.css";

export function NoteEditor({
  note,
  onClose,
}: {
  note: Note;
  onClose: () => void;
}) {
  const { navigate, refresh } = useApp();
  const toast = useToast();
  const tagId = useId();
  const [draft, setDraft] = useState<Note>({
    ...note,
    anchors: anchorsOf(note),
  });
  const [aiEnabled, setAiEnabled] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggested, setSuggested] = useState<string[]>([]);
  useEffect(() => {
    api
      .aiConfig()
      .then((c) => setAiEnabled(chatReady(c.chat)))
      .catch(() => {});
  }, []);
  const [tags, setTags] = useState((note.tags ?? []).join(", "));
  const [data, setData] = useState<Research>();
  const [saving, setSaving] = useState(false);
  const [sourceQuery, setSourceQuery] = useState("");
  const [sources, setSources] = useState<PaletteResults>();
  const [adding, setAdding] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [baseline, setBaseline] = useState(
    JSON.stringify({
      ...note,
      anchors: anchorsOf(note),
      tags: note.tags ?? [],
    }),
  );
  useEffect(() => {
    const n = { ...note, anchors: anchorsOf(note) };
    setDraft(n);
    setTags((note.tags ?? []).join(", "));
    setBaseline(JSON.stringify({ ...n, tags: note.tags ?? [] }));
  }, [note]);
  useEffect(() => {
    api.research().then(setData).catch(toast.error);
  }, [toast]);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      if (sourceQuery.trim())
        api
          .palette(sourceQuery)
          .then((v) => alive && setSources(v))
          .catch(toast.error);
      else setSources(undefined);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [sourceQuery, toast]);
  const current = () => ({ ...draft, tags: tagList(tags) });
  const close = () => {
    if (saving) return;
    if (JSON.stringify(current()) !== baseline) setDiscard(true);
    else onClose();
  };
  const anchors = draft.anchors ?? [];
  const update = (i: number, patch: Partial<NoteAnchor>) =>
    setDraft((n) => ({
      ...n,
      anchors: n.anchors!.map((a, j) => (i === j ? { ...a, ...patch } : a)),
    }));
  const add = (a: NoteAnchor) => {
    setDraft((n) => ({ ...n, anchors: [...(n.anchors ?? []), a] }));
    setAdding(false);
    setSourceQuery("");
  };
  const save = async (source?: NoteAnchor) => {
    if (saving) return;
    setSaving(true);
    try {
      await api.saveNote(current());
      refresh();
      toast.success("Note saved");
      onClose();
      if (source?.media_id)
        navigate({
          page: "recording",
          id: source.media_id,
          at: source.start ?? 0,
        });
      else if (source?.doc_id)
        navigate({ page: "documents", id: source.doc_id });
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(v) => !v && close()}
        title={draft.id ? "Research note" : "New note"}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={saving}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!draft.title.trim() || saving}
              onClick={() => void save()}
            >
              Save note
            </Button>
          </>
        }
      >
        <div className="note-editor">
          {!note.id && anchorsOf(note).length > 0 && !!data?.notes.length && (
            <Select
              label="Save passage to"
              value={draft.id ?? ""}
              options={[
                { value: "", label: "Create a new note" },
                ...data.notes.map((n) => ({ value: n.id!, label: n.title })),
              ]}
              onChange={(id) => {
                const target = data.notes.find((n) => n.id === id);
                const next = target
                  ? {
                      ...target,
                      anchors: [...anchorsOf(target), ...anchorsOf(note)],
                    }
                  : { ...note, anchors: anchorsOf(note) };
                setDraft(next);
                setTags((next.tags ?? []).join(", "));
                // Selecting an existing note deliberately adds evidence; it remains an unsaved change.
                if (!target)
                  setBaseline(
                    JSON.stringify({
                      ...note,
                      anchors: anchorsOf(note),
                      tags: note.tags ?? [],
                    }),
                  );
              }}
            />
          )}
          <input
            className="note-title-input"
            aria-label="Note title"
            placeholder="Give this thought a title"
            autoFocus
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            maxLength={500}
          />
          <textarea
            className="note-body-input"
            aria-label="Note"
            placeholder="What stands out to you?"
            rows={6}
            value={draft.body}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <label className="field">
            Tags
            <input
              aria-label="Note tags"
              list={tagId}
              placeholder="faith, leadership, history"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
            <small className="muted">
              Separate tags with commas. Dots group related tags, such as
              history.rome.
            </small>
            <datalist id={tagId}>
              {data?.tags?.map((t) => (
                <option
                  key={t.tag}
                  value={[...tagList(tags), t.tag].join(", ")}
                />
              ))}
            </datalist>
          </label>
          {aiEnabled && (
            <div className="note-tags">
              <Button
                size="sm"
                disabled={suggesting}
                onClick={async () => {
                  setSuggesting(true);
                  try {
                    setSuggested(
                      await api.aiSuggestTags(
                        `${draft.title}\n${draft.body}\n${anchors.map((a) => a.quote).join("\n")}`,
                      ),
                    );
                  } catch (e) {
                    toast.error(e);
                  } finally {
                    setSuggesting(false);
                  }
                }}
              >
                {suggesting ? "Suggesting…" : "Suggest tags with AI"}
              </Button>
              {suggested
                .filter((t) => !tagList(tags).includes(t))
                .map((t) => (
                  <Button
                    key={t}
                    size="sm"
                    variant="ghost"
                    onClick={() => setTags([...tagList(tags), t].join(", "))}
                  >
                    ＋ {t}
                  </Button>
                ))}
            </div>
          )}
          {!!data?.tags?.length && (
            <div className="note-tags">
              {data.tags
                .filter(
                  (t) =>
                    !tagList(tags).includes(t.tag) &&
                    `${draft.title} ${draft.body} ${anchors.map((a) => a.quote).join(" ")}`
                      .toLowerCase()
                      .includes(t.tag.replaceAll(".", " ")),
                )
                .slice(0, 6)
                .map((t) => (
                  <Button
                    key={t.tag}
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setTags([...tagList(tags), t.tag].join(", "))
                    }
                  >
                    ＋ {t.tag}
                  </Button>
                ))}
            </div>
          )}
          <div className="evidence-heading">
            <h3>Evidence · {anchors.length}</h3>
            <Button size="sm" icon={Plus} onClick={() => setAdding((v) => !v)}>
              Add source
            </Button>
          </div>
          {anchors.map((a, i) => (
            <section className="note-evidence" key={a.id ?? i}>
              <header>
                <strong>
                  {a.title ?? (a.media_id ? "Recording" : "Document")}
                </strong>
                <IconButton
                  size="sm"
                  label={`Remove evidence ${i + 1}`}
                  icon={X}
                  onClick={() =>
                    setDraft((n) => ({
                      ...n,
                      anchors: n.anchors!.filter((_, j) => j !== i),
                    }))
                  }
                />
              </header>
              {a.media_id && (
                <div className="evidence-times">
                  <label className="field">
                    Start (seconds)
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      aria-label={`Evidence ${i + 1} start`}
                      value={a.start ?? 0}
                      onChange={(e) =>
                        update(i, { start: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label className="field">
                    End (seconds)
                    <input
                      type="number"
                      min={a.start ?? 0}
                      step="0.1"
                      aria-label={`Evidence ${i + 1} end`}
                      value={a.end ?? a.start ?? 0}
                      onChange={(e) =>
                        update(i, { end: Number(e.target.value) })
                      }
                    />
                  </label>
                  <span className="muted">
                    {clock(a.start ?? 0)}–{clock(a.end ?? a.start ?? 0)}
                  </span>
                </div>
              )}
              {!a.media_id && !a.doc_id && <p className="muted">Recording removed from library · saved passage kept</p>}
              <textarea
                aria-label={`Evidence ${i + 1} passage`}
                rows={2}
                placeholder="Quoted passage"
                value={a.quote}
                onChange={(e) => update(i, { quote: e.target.value })}
              />
              <Button
                variant="ghost"
                size="sm"
                icon={Play}
                disabled={!draft.title.trim() || saving || (!a.media_id && !a.doc_id)}
                onClick={() => void save(a)}
              >
                Save & open source
              </Button>
            </section>
          ))}
          {adding && (
            <div className="note-add-source">
              <label className="field">
                Find a recording or document
                <input
                  aria-label="Find evidence source"
                  type="search"
                  value={sourceQuery}
                  onChange={(e) => setSourceQuery(e.target.value)}
                  placeholder="Type part of its title"
                />
              </label>
              {sources && (
                <div className="voice-options">
                  {sources.recordings.map((m) => (
                    <button
                      key={m.id}
                      onClick={() =>
                        add({
                          media_id: m.id,
                          title: m.title,
                          start: 0,
                          end: 0,
                          quote: "",
                        })
                      }
                    >
                      Recording · {m.title}
                    </button>
                  ))}
                  {sources.documents.map((d) => (
                    <button
                      key={d.id}
                      onClick={() =>
                        add({ doc_id: d.id, title: d.title, quote: "" })
                      }
                    >
                      Document · {d.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard unsaved changes?"
        body="Your last saved note will be kept."
        confirmLabel="Discard changes"
        danger
        onConfirm={onClose}
      />
    </>
  );
}
