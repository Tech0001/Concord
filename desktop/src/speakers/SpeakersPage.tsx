import { useEffect, useState, type CSSProperties } from "react";
import { ChevronDown, LoaderCircle, Play, Search, Users } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count, humanDuration, prettyDate } from "../lib/format.ts";
import { speakerColor } from "../lib/speakers.ts";
import { cx } from "../lib/cx.ts";
import type { Appearance, Speaker } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import "./speakers.css";

const FIRST_PAGE = 50;

/** Notes and every recording this voice appears in, like the Electron speaker row. */
function SpeakerDetail({ speaker, onNotesSaved }: { speaker: Speaker; onNotesSaved: (notes: string | null) => void }) {
  const { navigate } = useApp();
  const toast = useToast();
  const [appearances, setAppearances] = useState<Appearance[]>();
  const [notes, setNotes] = useState(speaker.notes ?? "");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .speakerAppearances(speaker.id)
      .then((list) => alive && setAppearances(list))
      .catch(toast.error);
    return () => {
      alive = false;
    };
  }, [speaker.id, toast]);
  const saveNotes = async () => {
    if (notes.trim() === (speaker.notes ?? "")) return;
    try {
      await api.setSpeakerNotes(speaker.id, notes);
      onNotesSaved(notes.trim() || null);
      toast.success("Speaker notes saved");
    } catch (e) {
      toast.error(e);
    }
  };
  const shown = appearances && !showAll ? appearances.slice(0, FIRST_PAGE) : appearances;
  return (
    <div className="speaker-detail">
      <label className="field speaker-notes">
        Notes
        <textarea
          rows={2}
          placeholder="Notes about this speaker (saved when you click away)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => void saveNotes()}
        />
      </label>
      <div className="appearances">
        <div className="appearances-head">
          <span className="filter-label">Appearances</span>
          {appearances && <span className="muted num">{count(appearances.length, "recording")}</span>}
        </div>
        {!appearances ? (
          <p className="muted appearances-loading">
            <LoaderCircle size={14} className="spin" aria-hidden /> Loading…
          </p>
        ) : appearances.length === 0 ? (
          <p className="muted">No appearances yet.</p>
        ) : (
          <ul className="appearance-list">
            {shown!.map((a) => (
              <li key={`${a.media_id}|${a.local_id}`}>
                <button
                  type="button"
                  className="appearance-row"
                  onClick={() => navigate({ page: "recording", id: a.media_id, ...(a.start != null ? { at: a.start } : {}) })}
                  title={a.start != null ? "Play from their longest turn" : "Open recording"}
                >
                  <span className="appearance-local mono">{a.local_id}</span>
                  <span className="appearance-play" aria-hidden>
                    <Play size={12} fill="currentColor" />
                  </span>
                  <span className="appearance-title">{a.title}</span>
                  <span className="appearance-meta">
                    {a.channel} · <span className="num">{prettyDate(a.date)}</span>
                  </span>
                  <Chip>{humanDuration(a.airtime)}</Chip>
                </button>
              </li>
            ))}
          </ul>
        )}
        {appearances && appearances.length > FIRST_PAGE && !showAll && (
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            Show all {appearances.length.toLocaleString("en-US")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function SpeakersPage() {
  const { revision } = useApp();
  const toast = useToast();
  const [speakers, setSpeakers] = useState<Speaker[]>();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api
      .speakers()
      .then(setSpeakers)
      .catch(toast.error);
  }, [revision, toast]);
  const total = (speakers ?? []).reduce((sum, s) => sum + s.airtime, 0);
  const shown = (speakers ?? []).filter((s) => s.name.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="speakers-page">
      <PageHeader title="Speakers" meta={speakers ? `${count(speakers.length, "voice")} · ${humanDuration(total)} of speech` : "Loading…"} />
      {speakers && speakers.length > 0 && (
        <label className="search-field speakers-filter">
          <Search size={15} aria-hidden />
          <input type="search" aria-label="Find a speaker" placeholder="Find a speaker…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      <ul className="speaker-rows">
        {shown.map((s) => {
          const expanded = open === s.id;
          return (
            <li key={s.id} className={cx("speaker-item", expanded && "is-open")} style={{ "--speaker": speakerColor(s.color, s.name) } as CSSProperties}>
              <button type="button" className="speaker-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : s.id)}>
                <i className="speaker-dot" aria-hidden />
                <span className="speaker-row-name">{s.name}</span>
                <span className="speaker-row-notes">{s.notes}</span>
                <span className="speaker-row-num num">{humanDuration(s.airtime)}</span>
                <span className="speaker-row-num speaker-row-count num">{count(s.recordings, "recording")}</span>
                <ChevronDown size={16} className="speaker-row-chevron" aria-hidden />
              </button>
              {expanded && (
                <SpeakerDetail
                  speaker={s}
                  onNotesSaved={(notes) => setSpeakers((list) => list?.map((x) => (x.id === s.id ? { ...x, notes } : x)))}
                />
              )}
            </li>
          );
        })}
      </ul>
      {speakers && !speakers.length && (
        <Empty icon={Users} title="No saved voices yet" text="Open a recording and name a voice to start your speaker library." />
      )}
      {speakers && speakers.length > 0 && !shown.length && <Empty icon={Search} title="No speakers match" text="Try a different name." />}
    </div>
  );
}
