import { useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, Play, Search } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock, count, prettyDate } from "../lib/format.ts";
import { groupHits, highlightParts } from "../lib/search.ts";
import { speakerColor, voiceLabel } from "../lib/speakers.ts";
import type { SearchHit } from "../lib/types.ts";
import { Chip, SpeakerChip } from "../ui/Chip.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import "./search.css";

function Marked({ text }: { text: string }) {
  return (
    <>
      {highlightParts(text).map((p, i) =>
        p.mark ? (
          <mark key={i} className="find-mark">
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

export function SearchPage({ q }: { q: string }) {
  const { navigate, revision } = useApp();
  const toast = useToast();
  const [text, setText] = useState(q);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (text !== q) navigate({ page: "search", q: text }, { replace: true });
    }, 250);
    return () => clearTimeout(timer);
  }, [text, q, navigate]);
  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .search(q)
      .then((r) => alive && setHits(r))
      .catch((e) => alive && toast.error(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [q, revision, toast]);
  const groups = useMemo(() => groupHits(hits), [hits]);
  return (
    <div className="search-page">
      <PageHeader title="Search" />
      <label className="search-hero">
        <Search size={20} aria-hidden />
        <input
          ref={input}
          type="search"
          aria-label="Search every transcript"
          placeholder="A name, a phrase, or a word you remember…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {loading && <LoaderCircle size={18} className="spin" aria-hidden />}
      </label>
      {q.trim() && (
        <div className="search-meta num">
          <span>
            {count(hits.length, "match", "matches")} across {count(groups.length, "recording")}
            {hits.length >= 200 && " · showing the first 200"}
          </span>
          <span className="muted">Word search · on this computer</span>
        </div>
      )}
      <div className="search-groups">
        {groups.map((g) => (
          <section key={g.id} className="search-group">
            <button type="button" className="search-group-head" onClick={() => navigate({ page: "recording", id: g.id, at: g.hits[0].start })}>
              <span className="search-group-title">{g.title}</span>
              <span className="search-group-meta">
                {g.channel} · <span className="num">{prettyDate(g.date)}</span>
              </span>
              <Chip>{count(g.hits.length, "match", "matches")}</Chip>
            </button>
            <ul className="search-hits">
              {g.hits.map((h, i) => {
                const name = h.speaker_name ?? (h.speaker ? voiceLabel(h.speaker) : "");
                return (
                  <li key={`${h.start}-${i}`}>
                    <button type="button" className="search-hit" onClick={() => navigate({ page: "recording", id: h.id, at: h.start })}>
                      <span className="search-hit-time mono">
                        <Play size={11} fill="currentColor" aria-hidden />
                        {clock(h.start)}
                      </span>
                      <span className="search-hit-body">
                        {name && <SpeakerChip size="sm" name={name} color={speakerColor(h.speaker_color, h.speaker_name ?? h.speaker ?? "")} />}
                        <span className="search-hit-text">
                          <Marked text={h.marked || h.text} />
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      {!q.trim() && <Empty icon={Search} title="Search every transcript" text="Find a name, a phrase, or a word you remember." />}
      {q.trim() && !loading && !hits.length && <Empty icon={Search} title="No matching passages" text="Try fewer words or a different spelling." />}
    </div>
  );
}
