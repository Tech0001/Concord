import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowDownToLine, AudioLines } from "lucide-react";
import { clock } from "../lib/format.ts";
import { indexAt, markParts } from "../lib/range.ts";
import type { TimeStore } from "../lib/timeStore.ts";
import type { NoteMarker, Segment } from "../lib/types.ts";
import { voiceLabel } from "../lib/speakers.ts";
import { cx } from "../lib/cx.ts";
import { Empty } from "../ui/Empty.tsx";
import type { Voice } from "./voices.ts";

/** Per-line state that changes with selection or find; kept primitive so rows memoize well. */
export type LineState = {
  inRange: boolean;
  edge: "" | "start" | "end" | "both";
  query: string;
  activeMatch: boolean;
};
const PLAIN: LineState = {
  inRange: false,
  edge: "",
  query: "",
  activeMatch: false,
};

export type PressHandlers = {
  onPointerDown: (e: PointerEvent) => void;
  onPointerMove: (e: PointerEvent) => void;
  onPointerUp: () => void;
};

type LineProps = {
  index: number;
  line: Segment;
  voice: Voice | undefined;
  showSpeaker: boolean;
  state: LineState;
  onLine: (index: number, e: MouseEvent) => void;
  onVoice: (local: string) => void;
  register: (index: number, el: HTMLDivElement | null) => void;
  press?: PressHandlers;
  noteMarks?: NoteMarker[];
  onNote?: (id: string) => void;
};

const TranscriptLine = memo(
  function TranscriptLine({ index, line, voice, showSpeaker, state, onLine, onVoice, register, press, noteMarks, onNote }: LineProps) {
    const name = voice?.name ?? (line.speaker ? voiceLabel(line.speaker) : "");
    return (
      <div
        ref={(el) => register(index, el)}
        className={cx("t-line", state.inRange && "is-in-range", state.activeMatch && "is-active-match", !!noteMarks?.length && "has-note")}
        data-line={index}
        data-edge={state.edge || undefined}
        style={voice ? ({ "--speaker": voice.color } as CSSProperties) : undefined}
        onClick={(e) => onLine(index, e)}
        {...press}
      >
        <button
          type="button"
          className="t-time mono"
          onClick={(e) => {
            e.stopPropagation();
            onLine(index, e);
          }}
          aria-label={`Play from ${clock(line.start)}`}
        >
          {clock(line.start)}
        </button>
        <div className="t-body">
          {showSpeaker && line.speaker && (
            <button
              type="button"
              className="t-speaker"
              onClick={(e) => {
                e.stopPropagation();
                onVoice(line.speaker!);
              }}
              title={voice?.named ? `${name} · rename voice` : "Name this voice"}
            >
              {name}
            </button>
          )}
          {!!noteMarks?.length && <div className="t-note-marks">{noteMarks.map((n,i) => <button key={`${n.id}:${i}`} type="button" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onNote?.(n.id); }} title="Open saved note">Note · {n.title}</button>)}</div>}
          <p className="t-text">
            {state.query
              ? markParts(line.text, state.query).map((p, i) =>
                  p.mark ? (
                    <mark key={i} className="find-mark">
                      {p.text}
                    </mark>
                  ) : (
                    p.text
                  ),
                )
              : line.text}
          </p>
        </div>
      </div>
    );
  },
  (a, b) =>
    a.index === b.index &&
    a.line === b.line &&
    a.voice === b.voice &&
    a.showSpeaker === b.showSpeaker &&
    a.onLine === b.onLine &&
    a.onVoice === b.onVoice &&
    a.register === b.register &&
    a.press === b.press &&
    a.noteMarks === b.noteMarks &&
    a.onNote === b.onNote &&
    a.state.inRange === b.state.inRange &&
    a.state.edge === b.state.edge &&
    a.state.query === b.state.query &&
    a.state.activeMatch === b.state.activeMatch,
);

export function Transcript({
  lines,
  voices,
  time,
  follow,
  setFollow,
  onLine,
  onVoice,
  scroller,
  stacked,
  lineState,
  press,
  header,
  footer,
  banner,
  notes,
  onNote,
}: {
  lines: Segment[];
  notes?: NoteMarker[];
  onNote?: (id: string) => void;
  voices: Map<string, Voice>;
  time: TimeStore;
  follow: boolean;
  setFollow: (follow: boolean) => void;
  onLine: (index: number, e: MouseEvent) => void;
  onVoice: (local: string) => void;
  scroller: RefObject<HTMLDivElement | null>;
  stacked: boolean;
  lineState?: (index: number) => LineState;
  press?: (index: number) => PressHandlers;
  header?: ReactNode;
  footer?: ReactNode;
  banner?: ReactNode;
}) {
  const noteMarks = useMemo(() => lines.map(line => notes?.filter(n => line.end > n.start && line.start < (n.end ?? n.start + 0.01))), [lines, notes]);
  const rows = useRef(new Map<number, HTMLDivElement>());
  const current = useRef(-1);
  const followRef = useRef(follow);
  followRef.current = follow;
  const register = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) rows.current.set(index, el);
    else rows.current.delete(index);
  }, []);
  const reveal = useCallback(
    (index: number) => {
      const row = rows.current.get(index);
      const root = scroller.current;
      if (!row || !root) return;
      // Scroll only this pane, and only when the active line leaves its reading area.
      // Instant movement can be interrupted by manual scrolling without a queued animation.
      const r = row.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      if (r.top < b.top + 32 || r.bottom > b.bottom - 80) {
        if (root.scrollHeight > root.clientHeight) root.scrollTop += r.top - b.top - root.clientHeight * 0.3;
        else row.scrollIntoView({ block: "nearest" });
      }
    },
    [scroller],
  );

  // Highlight the playing line directly on the DOM so rows don't re-render every frame.
  useEffect(() => {
    current.current = -1;
    const update = () => {
      const i = indexAt(lines, time.get());
      if (i === current.current) return;
      rows.current.get(current.current)?.removeAttribute("data-current");
      current.current = i;
      rows.current.get(i)?.setAttribute("data-current", "");
      if (followRef.current && i >= 0) reveal(i);
    };
    update();
    return time.subscribe(update);
  }, [lines, time, reveal]);
  useEffect(() => {
    if (follow && current.current >= 0) reveal(current.current);
  }, [follow, reveal]);

  const stopFollowing = () => {
    followRef.current = false;
    if (follow) setFollow(false);
  };
  return (
    <div className={cx("transcript", stacked && "is-stacked")}>
      {header}
      {banner}
      <div
        ref={scroller}
        className="transcript-scroll"
        onWheel={stopFollowing}
        onTouchMove={stopFollowing}
        onKeyDown={(e) => ["PageUp", "PageDown", "Home", "End"].includes(e.key) && stopFollowing()}
        onPointerDown={stopFollowing}
      >
        {!lines.length && (
          <Empty icon={AudioLines} title="No transcript yet" text="Choose Transcribe to create one, with speakers and timestamps." />
        )}
        {lines.map((line, i) => (
          <TranscriptLine
            key={i}
            index={i}
            line={line}
            voice={line.speaker ? voices.get(line.speaker) : undefined}
            showSpeaker={
              i === 0 ||
              (voices.get(lines[i - 1].speaker ?? "")?.speakerId ?? lines[i - 1].speaker) !==
                (voices.get(line.speaker ?? "")?.speakerId ?? line.speaker)
            }
            state={lineState ? lineState(i) : PLAIN}
            onLine={onLine}
            onVoice={onVoice}
            register={register}
            press={press?.(i)}
            noteMarks={noteMarks[i]}
            onNote={onNote}
          />
        ))}
      </div>
      {!follow && (
        <button type="button" className="follow-pill" onClick={() => setFollow(true)}>
          <ArrowDownToLine size={14} aria-hidden />
          Back to playback
        </button>
      )}
      {footer}
    </div>
  );
}
