import { useEffect, useState, type CSSProperties } from "react";
import { Search, Users } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count, humanDuration } from "../lib/format.ts";
import { speakerColor } from "../lib/speakers.ts";
import type { Speaker } from "../lib/types.ts";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import "./speakers.css";

export function SpeakersPage() {
  const { revision } = useApp();
  const toast = useToast();
  const [speakers, setSpeakers] = useState<Speaker[]>();
  const [query, setQuery] = useState("");
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
        {shown.map((s) => (
          <li key={s.id} className="speaker-row" style={{ "--speaker": speakerColor(s.color, s.name) } as CSSProperties}>
            <i className="speaker-dot" aria-hidden />
            <span className="speaker-row-name">{s.name}</span>
            <span className="speaker-row-notes">{s.notes}</span>
            <span className="speaker-row-num num">{humanDuration(s.airtime)}</span>
            <span className="speaker-row-num num">{count(s.recordings, "recording")}</span>
          </li>
        ))}
      </ul>
      {speakers && !speakers.length && (
        <Empty icon={Users} title="No saved voices yet" text="Open a recording and name a voice to start your speaker library." />
      )}
      {speakers && speakers.length > 0 && !shown.length && <Empty icon={Search} title="No speakers match" text="Try a different name." />}
    </div>
  );
}
