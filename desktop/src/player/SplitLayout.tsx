import { useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import { readStored, writeStored } from "../lib/storage.ts";
import { TABLET, useMediaQuery } from "../lib/media-query.ts";
import { cx } from "../lib/cx.ts";

const KEY = "player-video-width";
const DEFAULT = 64;

/** Media on the left, transcript on the right, with a draggable divider. Stacks on narrow screens. */
export function SplitLayout({ children }: { children: [ReactNode, ReactNode] }) {
  const stacked = useMediaQuery(TABLET);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [preferred, setPreferred] = useState(() => {
    const stored = Number(readStored<number>(KEY, DEFAULT));
    return Number.isFinite(stored) && stored >= 20 && stored <= 80 ? stored : DEFAULT;
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.getBoundingClientRect().width));
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [stacked]);
  useEffect(() => writeStored(KEY, preferred), [preferred]);
  if (stacked)
    return (
      <div className="player-stack">
        {children[0]}
        {children[1]}
      </div>
    );
  const available = width ? Math.max(520, width - 20) : 1200;
  const minimum = Math.max(20, (300 / available) * 100);
  const maximum = Math.min(80, 100 - (320 / available) * 100);
  const clamp = (value: number) => Math.min(maximum, Math.max(minimum, value));
  const split = clamp(preferred);
  const move = (clientX: number) => {
    const bounds = container.current?.getBoundingClientRect();
    if (bounds) setPreferred(clamp(((clientX - bounds.left - 10) / (bounds.width - 20)) * 100));
  };
  return (
    <div
      ref={container}
      className={cx("player-split", dragging && "is-resizing")}
      style={{ gridTemplateColumns: `minmax(0, ${split}fr) 20px minmax(0, ${100 - split}fr)` }}
    >
      {children[0]}
      <div
        className="split-divider"
        role="separator"
        tabIndex={0}
        aria-label="Resize media and transcript"
        aria-orientation="vertical"
        aria-valuemin={Math.round(minimum)}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(split)}
        aria-valuetext={`Media ${Math.round(split)}%, transcript ${Math.round(100 - split)}%`}
        title="Drag to resize. Double-click to reset."
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) move(event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => setPreferred(DEFAULT)}
        onKeyDown={(event) => {
          const next = ({ ArrowLeft: clamp(split - 2), ArrowRight: clamp(split + 2), Home: minimum, End: maximum, Enter: DEFAULT } as Record<
            string,
            number
          >)[event.key];
          if (next === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          setPreferred(next);
        }}
      >
        <span className="split-grip">
          <GripVertical size={14} />
        </span>
      </div>
      {children[1]}
    </div>
  );
}
