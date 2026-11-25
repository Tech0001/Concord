import { memo } from "react";
import { clock, prettyDate } from "../lib/format.ts";
import type { Media } from "../lib/types.ts";
import type { MenuEntry } from "../ui/Menu.tsx";
import { Cover } from "./Cover.tsx";
import { MoreMenu, SelectBox, SpeakerChips, StarButton, StatusChips } from "./parts.tsx";
import { jobProgress } from "./model.ts";

export const RecordingRow = memo(function RecordingRow({
  media,
  transcribing,
  menu,
  onOpen,
  onStar,
  selected = false,
  onSelect,
}: {
  media: Media;
  transcribing: boolean;
  menu: () => MenuEntry[];
  onOpen: () => void;
  onStar: () => void;
  selected?: boolean;
  onSelect?: (range: boolean) => void;
}) {
  const progress = jobProgress(media);
  return (
    <div className={selected ? "rec-row is-selected" : "rec-row"} role="row" aria-selected={onSelect ? selected : undefined}>
      <span className="rec-row-select" role="cell">
        {onSelect && <SelectBox media={media} selected={selected} onSelect={onSelect} />}
      </span>
      <span className="rec-row-star" role="cell">
        <StarButton media={media} onToggle={onStar} />
      </span>
      <span className="rec-row-thumb" role="cell" aria-hidden>
        <Cover media={media} compact />
      </span>
      <span className="rec-row-date num" role="cell">
        {prettyDate(media.date)}
      </span>
      <span className="rec-row-main" role="cell">
        <button type="button" className="rec-row-title stretched" onClick={onOpen} title={media.title}>
          {media.title}
        </button>
        <span className="rec-row-sub">
          {media.channel} · {prettyDate(media.date)} · {clock(media.duration)}
        </span>
        <SpeakerChips media={media} max={2} />
        {progress && <span className={`rec-row-progress is-${progress.tone}`}>{progress.label}</span>}
      </span>
      <span className="rec-row-channel" role="cell">
        {media.channel}
      </span>
      <span className="rec-row-num num" role="cell">
        {media.duration > 0 ? clock(media.duration) : "—"}
      </span>
      <span className="rec-row-num num rec-row-words" role="cell">
        {media.words ? media.words.toLocaleString("en-US") : "—"}
      </span>
      <span className="rec-row-status" role="cell">
        <StatusChips media={media} transcribing={transcribing} />
      </span>
      <span className="rec-row-menu" role="cell">
        <MoreMenu title={media.title} entries={menu()} />
      </span>
    </div>
  );
});
