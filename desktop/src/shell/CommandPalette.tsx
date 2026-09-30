import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { ArrowRight, AudioLines, FileText, Moon, NotebookPen, Plus, Search, Sun, type LucideIcon } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { prettyDate } from "../lib/format.ts";
import type { PaletteResults } from "../lib/types.ts";
import { useAppearance } from "../theme/theme.ts";
import { useToast } from "../ui/Toasts.tsx";
import { ANALYSIS, ARCHIVE } from "./nav.ts";
import { useApp } from "./AppContext.tsx";

const EMPTY: PaletteResults = { recordings: [], speakers: [], notes: [], documents: [] };

export function CommandPalette({ open, onOpenChange, onAdd }: { open: boolean; onOpenChange: (open: boolean) => void; onAdd: () => void }) {
  const { navigate, openNote } = useApp();
  const toast = useToast();
  const [appearance, setAppearance] = useAppearance();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PaletteResults>(EMPTY);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const timer = setTimeout(() => {
      api
        .palette(query)
        .then((r) => alive && setResults(r))
        .catch((e) => alive && toast.error(e));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, query, toast]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };
  const dark = document.documentElement.classList.contains("dark");
  const actions = useMemo(() => {
    const list: { id: string; label: string; icon: LucideIcon; run: () => void }[] = [];
    if (query.trim()) list.push({ id: "search", label: `Search transcripts for “${query.trim()}”`, icon: Search, run: () => navigate({ page: "search", q: query.trim() }) });
    list.push({ id: "add", label: "Add recordings", icon: Plus, run: onAdd });
    for (const n of [...ARCHIVE, ...ANALYSIS]) list.push({ id: `go-${n.page}`, label: `Go to ${n.label}`, icon: n.icon, run: () => navigate(n.route) });
    list.push({ id: "settings", label: "Open Settings", icon: ArrowRight, run: () => navigate({ page: "settings" }) });
    list.push({
      id: "mode",
      label: dark ? "Switch to light mode" : "Switch to dark mode",
      icon: dark ? Sun : Moon,
      run: () => setAppearance({ ...appearance, mode: dark ? "light" : "dark" }),
    });
    const q = query.trim().toLowerCase();
    return q ? list.filter((a) => a.id === "search" || a.label.toLowerCase().includes(q)) : list;
  }, [query, dark, appearance, navigate, onAdd, setAppearance]);
  const openNoteById = async (id: string) => {
    try {
      const research = await api.research();
      const note = research.notes.find((n) => n.id === id);
      if (note) openNote(note);
    } catch (e) {
      toast.error(e);
    }
  };
  const hasResults = results.recordings.length + results.speakers.length + results.notes.length + results.documents.length > 0;
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Search or jump to"
      shouldFilter={false}
      overlayClassName="overlay"
      contentClassName="palette"
    >
      <div className="palette-input">
        <Search size={17} aria-hidden />
        <Command.Input value={query} onValueChange={setQuery} placeholder="Search recordings, speakers, notes, documents…" />
      </div>
      <Command.List className="palette-list">
        {query.trim() && !hasResults && actions.length <= 1 && <Command.Empty className="palette-empty">No matches in your archive.</Command.Empty>}
        {results.recordings.length > 0 && (
          <Command.Group heading={query.trim() ? "Recordings" : "Recently opened"}>
            {results.recordings.map((r) => (
              <Command.Item key={r.id} value={`rec-${r.id}`} onSelect={() => run(() => navigate({ page: "recording", id: r.id }))}>
                <AudioLines size={16} aria-hidden />
                <span className="palette-item-text">
                  <span>{r.title}</span>
                  <small>
                    {r.channel} · {prettyDate(r.date)}
                  </small>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {results.speakers.length > 0 && (
          <Command.Group heading="Speakers">
            {results.speakers.map((s) => (
              <Command.Item key={s.id} value={`spk-${s.id}`} onSelect={() => run(() => navigate({ page: "speakers" }))}>
                <i className="palette-dot" style={{ background: s.color ?? "var(--muted-foreground)" }} aria-hidden />
                <span className="palette-item-text">
                  <span>{s.name}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {results.notes.length > 0 && (
          <Command.Group heading="Notes">
            {results.notes.map((n) => (
              <Command.Item key={n.id} value={`note-${n.id}`} onSelect={() => run(() => void openNoteById(n.id))}>
                <NotebookPen size={16} aria-hidden />
                <span className="palette-item-text">
                  <span>{n.title}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {results.documents.length > 0 && (
          <Command.Group heading="Documents">
            {results.documents.map((d) => (
              <Command.Item key={d.id} value={`doc-${d.id}`} onSelect={() => run(() => navigate({ page: "documents", id: d.id }))}>
                <FileText size={16} aria-hidden />
                <span className="palette-item-text">
                  <span>{d.title}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {actions.length > 0 && (
          <Command.Group heading="Actions">
            {actions.map((a) => (
              <Command.Item key={a.id} value={`act-${a.id}`} onSelect={() => run(a.run)}>
                <a.icon size={16} aria-hidden />
                <span className="palette-item-text">
                  <span>{a.label}</span>
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
      <footer className="palette-foot">
        <span>
          <kbd className="kbd">↑</kbd>
          <kbd className="kbd">↓</kbd> move
        </span>
        <span>
          <kbd className="kbd">↵</kbd> open
        </span>
        <span>
          <kbd className="kbd">Esc</kbd> close
        </span>
      </footer>
    </Command.Dialog>
  );
}
