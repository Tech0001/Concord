import type { ReactNode } from "react";
import { Play } from "lucide-react";
import { groupHits, highlightParts } from "../lib/search.ts";
import { clock, prettyDate } from "../lib/format.ts";
import type { ResearchHit } from "../ai/types.ts";
import { useApp } from "../shell/AppContext.tsx";
import { SpeakerChip } from "../ui/Chip.tsx";

export function GroupedResults({ hits, renderOther }: { hits: ResearchHit[]; renderOther: (hit: ResearchHit) => ReactNode }) {
  const { navigate } = useApp();
  return <div className="search-groups">{groupHits(hits).map(group => {
    if (group.hits[0].kind !== "recording") return <div key={group.key}>{renderOther(group.hits[0])}</div>;
    return <section className="search-group" key={group.key} aria-label={group.title}>
      <button className="search-group-head" onClick={() => navigate({ page: "recording", id: group.id, at: group.hits[0].start ?? 0 })}>
        <span className="search-group-title">{group.title}</span>
        <span className="search-group-meta">{[group.channel, prettyDate(group.date)].filter(Boolean).join(" · ")}</span>
        <small>{group.hits.length} {group.hits.length === 1 ? "passage" : "passages"}</small>
      </button>
      <ul className="search-hits">{[...group.hits].sort((a,b) => (a.start ?? 0) - (b.start ?? 0)).map((hit,i) => <li key={`${hit.start}:${i}`}>
        <button className="search-hit" onClick={() => navigate({ page: "recording", id: hit.id, at: hit.start ?? 0 })}>
          <span className="search-hit-time mono"><Play size={11}/>{clock(hit.start ?? 0)}</span>
          <span className="search-hit-body">
            {hit.speaker_name ? <SpeakerChip name={hit.speaker_name} color={hit.speaker_color || "var(--primary)"} size="sm"/> : hit.speaker && <small className="muted">Unidentified voice</small>}
            <span className="search-hit-text">{highlightParts(hit.marked ?? hit.text).map((part,n) => part.mark ? <mark key={n}>{part.text}</mark> : part.text)}</span>
          </span>
        </button>
      </li>)}</ul>
    </section>;
  })}</div>;
}
