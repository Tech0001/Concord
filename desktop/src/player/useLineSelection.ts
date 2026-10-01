import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { spanRange, type Range, type Timed } from "../lib/range.ts";
import type { PressHandlers } from "./Transcript.tsx";

const lineIndexOf = (node: Node | null, root: HTMLElement): number | null => {
  const el = node instanceof Element ? node : node?.parentElement;
  const row = el?.closest<HTMLElement>("[data-line]");
  return row && root.contains(row) ? Number(row.dataset.line) : null;
};

/**
 * Line-level selection: shift-click extends from an anchor, text selected across lines selects those
 * lines, and on touch a long press starts a selection that later taps extend. Handlers are stable so
 * transcript rows stay memoized.
 */
export function useLineSelection({
  lines,
  scroller,
  onRange,
  onSeekLine,
}: {
  lines: Timed[];
  scroller: RefObject<HTMLElement | null>;
  onRange: (r: Range) => void;
  onSeekLine: (index: number) => void;
}) {
  const [anchor, setAnchor] = useState<number | null>(null);
  const [selecting, setSelecting] = useState(false);
  const latest = useRef({ lines, onRange, onSeekLine, anchor, selecting });
  latest.current = { lines, onRange, onSeekLine, anchor, selecting };
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    let timer = 0;
    const onChange = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const root = scroller.current;
        const sel = document.getSelection();
        if (!root || !sel || sel.isCollapsed || sel.rangeCount === 0) return;
        const a = lineIndexOf(sel.anchorNode, root);
        const b = lineIndexOf(sel.focusNode, root);
        if (a == null || b == null) return;
        setAnchor(a);
        latest.current.onRange(spanRange(latest.current.lines, a, b));
      }, 120);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", onChange);
    };
  }, [scroller]);

  const handleLine = useCallback((i: number, e: MouseEvent) => {
    const { lines, onRange, onSeekLine, anchor, selecting } = latest.current;
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const timestamp = e.currentTarget instanceof Element && e.currentTarget.matches(".t-time");
    if (timestamp) document.getSelection()?.removeAllRanges();
    else if (!document.getSelection()?.isCollapsed) return; // a drag selection, handled by selectionchange
    if (selecting || e.shiftKey) {
      onRange(spanRange(lines, anchor ?? i, i));
      if (anchor == null) setAnchor(i);
      return;
    }
    setAnchor(i);
    onSeekLine(i);
  }, []);

  const cache = useRef(new Map<number, PressHandlers>());
  useEffect(() => cache.current.clear(), [lines]);
  const pressHandlers = useCallback((i: number): PressHandlers => {
    const cached = cache.current.get(i);
    if (cached) return cached;
    const handlers: PressHandlers = {
      onPointerDown: (e: PointerEvent) => {
        if (e.pointerType !== "touch") return;
        const timer = window.setTimeout(() => {
          press.current = null;
          suppressClick.current = true;
          setSelecting(true);
          setAnchor(i);
          latest.current.onRange(spanRange(latest.current.lines, i, i));
          navigator.vibrate?.(10);
        }, 450);
        press.current = { timer, x: e.clientX, y: e.clientY };
      },
      onPointerMove: (e: PointerEvent) => {
        const p = press.current;
        if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
          clearTimeout(p.timer);
          press.current = null;
        }
      },
      onPointerUp: () => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = null;
      },
    };
    cache.current.set(i, handlers);
    return handlers;
  }, []);

  return { anchor, setAnchor, selecting, setSelecting, handleLine, pressHandlers };
}
