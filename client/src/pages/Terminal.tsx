import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Pause, Play, Search, SquareTerminal, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type LogLevel = "log" | "info" | "warn" | "error" | "debug";

interface RuntimeLogEntry {
  id: number;
  timestamp: string;
  level: LogLevel;
  message: string;
}

const levelClass: Record<LogLevel, string> = {
  log: "text-zinc-300",
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-red-300",
  debug: "text-violet-300",
};

function timeLabel(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function Terminal() {
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [paused, setPaused] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [filter, setFilter] = useState("");
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef(new Set<number>());
  const pausedRef = useRef(false);
  const pendingEntries = useRef<RuntimeLogEntry[]>([]);

  const appendEntries = (incoming: RuntimeLogEntry[]) => {
    const fresh = incoming.filter(entry => {
      if (seenIds.current.has(entry.id)) return false;
      seenIds.current.add(entry.id);
      return true;
    });
    if (fresh.length === 0) return;
    setEntries(previous => [...previous, ...fresh].slice(-2_000));
  };

  useEffect(() => {
    const source = new EventSource("/api/runtime-logs/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    const onLog = (event: Event) => {
      try {
        const entry = JSON.parse((event as MessageEvent<string>).data) as RuntimeLogEntry;
        if (pausedRef.current) {
          pendingEntries.current.push(entry);
          if (pendingEntries.current.length > 2_000) pendingEntries.current.shift();
          setPendingCount(pendingEntries.current.length);
        } else {
          appendEntries([entry]);
        }
      } catch {
        // A malformed line should not take down the terminal view.
      }
    };
    source.addEventListener("log", onLog);
    return () => {
      source.removeEventListener("log", onLog);
      source.close();
    };
  }, []);

  const visibleEntries = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(entry =>
      entry.message.toLowerCase().includes(query) || entry.level.includes(query),
    );
  }, [entries, filter]);

  useEffect(() => {
    if (!follow || paused) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const frame = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [visibleEntries, follow, paused]);

  const togglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next && pendingEntries.current.length > 0) {
      const waiting = pendingEntries.current.splice(0);
      setPendingCount(0);
      appendEntries(waiting);
    }
  };

  const clear = async () => {
    await fetch("/api/runtime-logs", { method: "DELETE" }).catch(() => undefined);
    seenIds.current.clear();
    pendingEntries.current = [];
    setPendingCount(0);
    setEntries([]);
  };

  const copy = async () => {
    const text = visibleEntries
      .map(entry => `[${entry.timestamp}] ${entry.level.toUpperCase()} ${entry.message}`)
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <div className="flex h-[calc(100vh-3rem)] min-h-[480px] flex-col gap-3 px-4 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <SquareTerminal className="h-5 w-5" />Server Terminal
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Read-only live output from Concord's embedded server and its tools.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className={cn("h-2 w-2 rounded-full", connected ? "bg-emerald-500" : "bg-amber-500")} />
          {connected ? "Connected" : "Reconnecting…"}
          <span>·</span>
          <span>{entries.length.toLocaleString()} lines</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={filter}
            onChange={event => setFilter(event.target.value)}
            placeholder="Filter output…"
            className="h-8 pl-8 font-mono text-xs"
          />
        </div>
        <Button size="sm" variant={paused ? "secondary" : "outline"} className="h-8" onClick={togglePause}>
          {paused ? <Play className="mr-1.5 h-3.5 w-3.5" /> : <Pause className="mr-1.5 h-3.5 w-3.5" />}
          {paused ? `Resume${pendingCount ? ` (${pendingCount})` : ""}` : "Pause"}
        </Button>
        <Button size="sm" variant={follow ? "secondary" : "outline"} className="h-8" onClick={() => setFollow(value => !value)}>
          <span className={cn("mr-1.5 h-2 w-2 rounded-full", follow ? "bg-emerald-500" : "bg-muted-foreground")} />
          Follow
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => void copy()} disabled={visibleEntries.length === 0}>
          {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => void clear()}>
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />Clear
        </Button>
      </div>

      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto rounded-lg border border-zinc-800 bg-[#090b0f] p-3 font-mono text-[11px] leading-5 shadow-inner"
        role="log"
        aria-live={paused ? "off" : "polite"}
      >
        {visibleEntries.length === 0 ? (
          <div className="py-12 text-center text-zinc-600">
            {filter ? "No output matches this filter." : "Waiting for server output…"}
          </div>
        ) : visibleEntries.map(entry => (
          <div key={entry.id} className="grid grid-cols-[5.25rem_3.25rem_minmax(0,1fr)] gap-x-2 border-b border-zinc-900/60 py-0.5 last:border-0">
            <span className="select-none text-zinc-600">{timeLabel(entry.timestamp)}</span>
            <span className={cn("select-none uppercase", levelClass[entry.level])}>{entry.level}</span>
            <span className="whitespace-pre-wrap break-words text-zinc-300">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
