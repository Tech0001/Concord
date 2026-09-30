import { memo } from "react";
import { prettyDate } from "../lib/format.ts";
import type { Media } from "../lib/types.ts";
import type { MenuEntry } from "../ui/Menu.tsx";
import { Cover } from "./Cover.tsx";
import { MoreMenu, SpeakerChips, StarButton, StatusChips } from "./parts.tsx";

export const RecordingCard = memo(function RecordingCard({
  media,
  transcribing,
  menu,
  onOpen,
  onStar,
}: {
  media: Media;
  transcribing: boolean;
  menu: () => MenuEntry[];
  onOpen: () => void;
  onStar: () => void;
}) {
  return (
    <article className="rec-card">
      <Cover media={media} />
      <StarButton media={media} onToggle={onStar} className="rec-card-star" />
      <div className="rec-card-body">
        <div className="rec-card-title-row">
          <button type="button" className="rec-card-title stretched" onClick={onOpen} title={media.title}>
            {media.title}
          </button>
          <MoreMenu title={media.title} entries={menu()} />
        </div>
        <p className="rec-card-meta">
          {media.channel} · <span className="num">{prettyDate(media.date)}</span>
        </p>
        <div className="rec-card-foot">
          <SpeakerChips media={media} max={2} />
          <StatusChips media={media} transcribing={transcribing} />
        </div>
      </div>
    </article>
  );
});
