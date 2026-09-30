import { Copy, Download, NotebookPen, Play, Repeat, Square, X, type LucideIcon } from "lucide-react";
import { clock, spanLabel } from "../lib/format.ts";
import { PHONE, useMediaQuery } from "../lib/media-query.ts";
import type { Range } from "../lib/range.ts";
import { Button, IconButton } from "../ui/Button.tsx";

export function RangeBar({
  range,
  playing,
  loop,
  onPlay,
  onStop,
  onLoop,
  onCopy,
  onExport,
  onSaveNote,
  onClear,
}: {
  range: Range;
  playing: boolean;
  loop: boolean;
  onPlay: () => void;
  onStop: () => void;
  onLoop: () => void;
  onCopy: () => void;
  onExport: () => void;
  onSaveNote: () => void;
  onClear: () => void;
}) {
  const phone = useMediaQuery(PHONE);
  const action = (label: string, icon: LucideIcon, run: () => void, active?: boolean) =>
    phone ? (
      <IconButton label={label} icon={icon} onClick={run} active={active} />
    ) : (
      <Button
        variant="ghost"
        size="sm"
        icon={icon}
        onClick={run}
        aria-pressed={active}
        aria-label={label}
        data-tip={label}
        className={active ? "toggle-btn range-action" : "range-action"}
      >
        <span className="range-label">{label}</span>
      </Button>
    );
  return (
    <div className="range-bar" role="toolbar" aria-label="Selected range">
      <span className="range-bar-info">
        <span className="mono num">
          {clock(range.start)} – {clock(range.end)}
        </span>
        <span className="muted num">{spanLabel(range.end - range.start)}</span>
      </span>
      <span className="range-bar-actions">
        {playing ? action("Stop", Square, onStop) : action("Play", Play, onPlay)}
        {action("Loop", Repeat, onLoop, loop)}
        {action("Copy", Copy, onCopy)}
        {action("Export", Download, onExport)}
        {action("Save note", NotebookPen, onSaveNote)}
        <IconButton label="Clear selection" icon={X} size="sm" onClick={onClear} />
      </span>
    </div>
  );
}
