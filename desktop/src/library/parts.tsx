import { LoaderCircle, MoreHorizontal, Star } from "lucide-react";
import { cx } from "../lib/cx.ts";
import { speakerColor } from "../lib/speakers.ts";
import type { Media } from "../lib/types.ts";
import { Chip, SpeakerChip } from "../ui/Chip.tsx";
import { IconButton } from "../ui/Button.tsx";
import { Menu, type MenuEntry } from "../ui/Menu.tsx";
import { REVIEW_LABELS } from "./recordingMenu.ts";

export function StarButton({ media, onToggle, className }: { media: Media; onToggle: () => void; className?: string }) {
  return (
    <IconButton
      label={media.starred ? "Remove star" : "Star"}
      icon={Star}
      size="sm"
      active={!!media.starred}
      className={cx("star-btn", !!media.starred && "is-starred", className)}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

export function SpeakerChips({ media, max = 3 }: { media: Media; max?: number }) {
  const list = media.speakers ?? [];
  const extra = (media.speaker_total ?? list.length) - Math.min(max, list.length);
  if (!list.length) return null;
  return (
    <span className="speaker-chips">
      {list.slice(0, max).map((s) => (
        <SpeakerChip key={s.name} name={s.name} color={speakerColor(s.color, s.name)} size="sm" />
      ))}
      {extra > 0 && <Chip>+{extra}</Chip>}
    </span>
  );
}

export function StatusChips({ media, transcribing }: { media: Media; transcribing: boolean }) {
  return (
    <span className="status-chips">
      {transcribing ? (
        <Chip tone="accent">
          <LoaderCircle size={11} className="spin" aria-hidden />
          Transcribing
        </Chip>
      ) : (
        !media.transcript && <Chip>Not transcribed</Chip>
      )}
      {media.review_state !== "unreviewed" && (
        <Chip tone={media.review_state === "reviewed" ? "success" : "warn"}>{REVIEW_LABELS[media.review_state]}</Chip>
      )}
    </span>
  );
}

export function MoreMenu({ entries, title }: { entries: MenuEntry[]; title: string }) {
  return <Menu label={title} entries={entries} trigger={<IconButton label="More actions" icon={MoreHorizontal} size="sm" className="more-btn" />} />;
}
