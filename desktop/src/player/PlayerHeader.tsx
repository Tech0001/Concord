import { ArrowLeft, ChevronLeft, ChevronRight, Sparkles, Star } from "lucide-react";
import { clock, count, prettyDate } from "../lib/format.ts";
import { neighbors } from "../lib/session.ts";
import type { Recording } from "../lib/types.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import type { MenuEntry } from "../ui/Menu.tsx";
import { MoreMenu } from "../library/parts.tsx";
import { useApp } from "../shell/AppContext.tsx";

export function modelLabel(model: string): string {
  if (!model) return "Awaiting transcription";
  return model.toLowerCase().includes("nemotron") ? "Nemotron 3.5 · multilingual" : model.split("/").pop() ?? model;
}

export function PlayerHeader({
  recording,
  starred,
  onStar,
  menu,
}: {
  recording: Recording;
  starred: boolean;
  onStar: () => void;
  menu: MenuEntry[];
}) {
  const { navigate, back, transcribe, activeJob, jobs } = useApp();
  const media = recording.media;
  const { previous, next } = neighbors(media.id);
  const busy = activeJob?.media_id === media.id;
  const queued = jobs.some(j => j.media_id === media.id && ["queued", "retry"].includes(j.status));
  return (
    <header className="player-header">
      <div className="player-nav">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => (history.length > 1 ? back() : navigate({ page: "library" }))}>
          Library
        </Button>
        <span className="player-nav-steps">
          <IconButton
            label={previous ? `Previous: ${previous.title}` : "No previous recording"}
            icon={ChevronLeft}
            size="sm"
            disabled={!previous}
            onClick={() => previous && navigate({ page: "recording", id: previous.id }, { replace: true })}
          />
          <IconButton
            label={next ? `Next: ${next.title}` : "No next recording"}
            icon={ChevronRight}
            size="sm"
            disabled={!next}
            onClick={() => next && navigate({ page: "recording", id: next.id }, { replace: true })}
          />
        </span>
      </div>
      <div className="player-title-row">
        <div className="player-title">
          <h1>{media.title}</h1>
          <p className="player-meta num">
            {[media.channel, prettyDate(media.date), media.duration > 0 && clock(media.duration), media.words > 0 && count(media.words, "word"), modelLabel(recording.model)]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="player-actions">
          <Button
            variant={media.transcript ? "secondary" : "primary"}
            icon={Sparkles}
            disabled={busy || queued || (!media.path && !media.url)}
            onClick={() => void transcribe(media.id)}
          >
            {busy ? "Processing…" : queued ? "Queued" : !media.path && media.url ? "Download & transcribe" : media.transcript ? "Re-transcribe" : "Transcribe"}
          </Button>
          <IconButton label={starred ? "Remove star" : "Star"} icon={Star} active={starred} className={starred ? "star-btn is-starred" : "star-btn"} onClick={onStar} />
          <MoreMenu title={media.title} entries={menu} />
        </div>
      </div>
    </header>
  );
}
