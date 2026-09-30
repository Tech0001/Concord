import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { NoteMarker } from "../lib/types.ts";
import { clampRange, type Range } from "../lib/range.ts";
import { useTime, type TimeStore } from "../lib/timeStore.ts";
import { clock } from "../lib/format.ts";
import { cx } from "../lib/cx.ts";

export type LaneTurn = { start: number; end: number; color: string; label: string };
type Drag = "seek" | "start" | "end" | null;

/** Scrubbable timeline: waveform (audio), speaker lane, saved-note markers, range band with handles, playhead. */
export function Timeline({
  duration,
  time,
  turns,
  peaks,
  range,
  notes,
  onSeek,
  onRangeChange,
  onNote,
}: {
  duration: number;
  time: TimeStore;
  turns: LaneTurn[];
  peaks: number[] | null;
  range: Range | null;
  notes: NoteMarker[];
  onSeek: (t: number) => void;
  onRangeChange: (r: Range) => void;
  onNote: (n: NoteMarker) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const pct = (t: number) => `${duration > 0 ? (Math.min(Math.max(t, 0), duration) / duration) * 100 : 0}%`;
  const toTime = (clientX: number) => {
    const b = track.current!.getBoundingClientRect();
    return Math.min(Math.max((clientX - b.left) / b.width, 0), 1) * duration;
  };
  const begin = (kind: Exclude<Drag, null>) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !duration) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag(kind);
    if (kind === "seek") onSeek(toTime(e.clientX));
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    if (!duration) return;
    const t = toTime(e.clientX);
    setHover(t);
    if (drag === "seek") onSeek(t);
    else if (drag === "start" && range) onRangeChange(clampRange({ start: Math.min(t, range.end - 0.5), end: range.end }, duration));
    else if (drag === "end" && range) onRangeChange(clampRange({ start: range.start, end: Math.max(t, range.start + 0.5) }, duration));
  };
  const end = () => setDrag(null);
  const nudge = (edge: "start" | "end") => (e: React.KeyboardEvent) => {
    const d = ({ ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>)[e.key];
    if (!d || !range) return;
    e.preventDefault();
    e.stopPropagation();
    const step = d * (e.shiftKey ? 0.1 : 1);
    onRangeChange(
      clampRange(edge === "start" ? { start: range.start + step, end: range.end } : { start: range.start, end: range.end + step }, duration),
    );
  };
  return (
    <div className={cx("timeline", peaks && "has-waveform", drag && "is-dragging")}>
      <div
        ref={track}
        className="timeline-track"
        role="slider"
        tabIndex={0}
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(time.get())}
        aria-valuetext={clock(time.get())}
        onPointerDown={begin("seek")}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onPointerLeave={() => !drag && setHover(null)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 60 : 5;
          const next = ({ ArrowLeft: time.get() - step, ArrowRight: time.get() + step, Home: 0, End: duration } as Record<string, number>)[
            e.key
          ];
          if (next === undefined) return;
          e.preventDefault();
          e.stopPropagation();
          onSeek(next);
        }}
      >
        {peaks && <Waveform peaks={peaks} />}
        <div className="speaker-lane" aria-hidden>
          {turns.map((t, i) => (
            <span
              key={i}
              style={{ left: pct(t.start), width: `calc(${pct(t.end)} - ${pct(t.start)})`, background: t.color }}
              title={`${t.label} · ${clock(t.start)}–${clock(t.end)}`}
            />
          ))}
        </div>
        {range && (
          <div className="range-band" style={{ left: pct(range.start), width: `calc(${pct(range.end)} - ${pct(range.start)})` }}>
            <span
              className="range-handle is-start"
              role="slider"
              tabIndex={0}
              aria-label="Range start"
              aria-valuenow={Math.round(range.start)}
              aria-valuetext={clock(range.start)}
              onPointerDown={begin("start")}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={nudge("start")}
            />
            <span
              className="range-handle is-end"
              role="slider"
              tabIndex={0}
              aria-label="Range end"
              aria-valuenow={Math.round(range.end)}
              aria-valuetext={clock(range.end)}
              onPointerDown={begin("end")}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
              onKeyDown={nudge("end")}
            />
          </div>
        )}
        {notes.map((n) => (
          <button
            key={n.id}
            type="button"
            className="note-marker"
            style={{ left: pct(n.start) }}
            title={n.title}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onNote(n)}
            aria-label={`Note: ${n.title} at ${clock(n.start)}`}
          />
        ))}
        <Playhead time={time} duration={duration} />
        {hover != null && (
          <span className="hover-time num" style={{ left: pct(hover) }}>
            {clock(hover)}
          </span>
        )}
      </div>
    </div>
  );
}

function Playhead({ time, duration }: { time: TimeStore; duration: number }) {
  const t = useTime(time, (v) => Math.round(v * 20) / 20);
  return <span className="playhead" style={{ left: `${duration > 0 ? (Math.min(t, duration) / duration) * 100 : 0}%` }} aria-hidden />;
}

/** Mirrored peak bars, redrawn on resize and theme change. */
function Waveform({ peaks }: { peaks: number[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const draw = () => {
      const { width, height } = el.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      el.width = Math.round(width * scale);
      el.height = Math.round(height * scale);
      const ctx = el.getContext("2d");
      if (!ctx || !el.width) return;
      ctx.clearRect(0, 0, el.width, el.height);
      ctx.fillStyle = getComputedStyle(el).color;
      const max = Math.max(0.05, ...peaks);
      const bars = Math.min(peaks.length, Math.floor(el.width / (2 * scale)));
      const mid = el.height / 2;
      for (let i = 0; i < bars; i++) {
        const from = Math.floor((i * peaks.length) / bars);
        const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bars));
        let peak = 0;
        for (let j = from; j < to; j++) peak = Math.max(peak, peaks[j]);
        const h = Math.max(scale, (Math.sqrt(peak / max) * el.height * 0.92) / 2);
        ctx.fillRect(i * 2 * scale, mid - h, scale, h * 2);
      }
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(el);
    const themeObserver = new MutationObserver(draw);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
    };
  }, [peaks]);
  return <canvas ref={canvas} className="waveform" aria-hidden />;
}
