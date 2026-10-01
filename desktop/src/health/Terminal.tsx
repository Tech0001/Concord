import { useEffect, useRef, useState } from "react";
import { Copy, Pause, Play, Search, Trash2, ArrowDown } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { LogEntry } from "./types.ts";
export function Terminal() {
  const [entries, setEntries] = useState<LogEntry[]>([]),
    [paused, setPaused] = useState(false),
    [filter, setFilter] = useState(""),
    [follow, setFollow] = useState(true),
    [connected, setConnected] = useState(false),
    [pending, setPending] = useState(0);
  const cursor = useRef(0),
    buffer = useRef<LogEntry[]>([]),
    pauseRef = useRef(paused),
    viewport = useRef<HTMLDivElement>(null);
  const toast = useToast();
  useEffect(() => {
    pauseRef.current = paused;
    if (!paused && buffer.current.length) {
      setEntries((e) => [...e, ...buffer.current].slice(-2000));
      buffer.current = [];
      setPending(0);
    }
  }, [paused]);
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const incoming = await api.runtimeLogs(cursor.current);
        if (!alive) return;
        setConnected(true);
        if (incoming.length) {
          cursor.current = incoming.at(-1)!.id;
          if (pauseRef.current) {
            buffer.current = [...buffer.current, ...incoming].slice(-2000);
            setPending(buffer.current.length);
          } else setEntries((e) => [...e, ...incoming].slice(-2000));
        }
      } catch {
        if (alive) setConnected(false);
      }
      if (alive) timer = window.setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const shown = entries.filter((e) =>
    `${e.level} ${e.message}`.toLowerCase().includes(filter.toLowerCase()),
  );
  useEffect(() => {
    if (follow && !paused && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [entries, filter, follow, paused]);
  return (
    <section className="archive-terminal" aria-label="Application terminal">
      <header>
        <div>
          <h3>Application terminal</h3>
          <p className="muted">
            Read-only output from Concord and its background tools.
          </p>
        </div>
        <span className={connected ? "terminal-connected" : "is-error"}>
          {connected ? "Connected" : "Reconnecting…"} · {entries.length} lines
        </span>
      </header>
      <div className="terminal-controls">
        <label className="search-field">
          <Search size={14} />
          <input
            aria-label="Filter log output"
            placeholder="Filter output…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
        <Button
          size="sm"
          icon={paused ? Play : Pause}
          onClick={() => setPaused(!paused)}
        >
          {paused ? `Resume${pending ? ` (${pending})` : ""}` : "Pause"}
        </Button>
        <Button
          size="sm"
          icon={ArrowDown}
          aria-pressed={follow}
          onClick={() => setFollow(!follow)}
        >
          Follow
        </Button>
        <Button
          size="sm"
          icon={Copy}
          onClick={() =>
            void navigator.clipboard
              .writeText(
                shown
                  .map(
                    (e) =>
                      `${new Date(e.timestamp).toISOString()} ${e.level.toUpperCase()} ${e.message}`,
                  )
                  .join("\n"),
              )
              .then(() => toast.success("Log copied"))
              .catch(toast.error)
          }
        >
          Copy
        </Button>
        <Button
          size="sm"
          icon={Trash2}
          onClick={() => {
            setEntries([]);
            buffer.current = [];
            setPending(0);
          }}
        >
          Clear
        </Button>
      </div>
      <div
        className="terminal-output"
        ref={viewport}
        tabIndex={0}
        aria-label="Live application output"
      >
        {shown.map((e) => (
          <div className={`terminal-line level-${e.level}`} key={e.id}>
            <time>{new Date(e.timestamp).toLocaleTimeString()}</time>
            <b>{e.level.toUpperCase()}</b>
            <span>{e.message}</span>
          </div>
        ))}
        {!shown.length && (
          <p className="muted">
            {filter
              ? "No matching output."
              : "Waiting for application activity…"}
          </p>
        )}
      </div>
    </section>
  );
}
