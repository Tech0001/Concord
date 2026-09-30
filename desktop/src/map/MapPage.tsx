import { useEffect, useState } from "react";
import { Link2, Network } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import type { Research } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import "./map.css";

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function MapPage() {
  const { revision, refresh, openNote } = useApp();
  const toast = useToast();
  const [data, setData] = useState<Research>();
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  useEffect(() => {
    api.research().then(setData).catch(toast.error);
  }, [revision, toast]);
  const notes = data?.notes ?? [];
  const points = notes.map((note, i) => ({
    note,
    x: 450 + 290 * Math.cos((i / notes.length) * 2 * Math.PI - Math.PI / 2),
    y: 300 + 200 * Math.sin((i / notes.length) * 2 * Math.PI - Math.PI / 2),
  }));
  const options = notes.map((n) => ({ value: n.id!, label: n.title }));
  const link = async () => {
    try {
      await api.linkNotes(source, target);
      toast.success("Notes connected");
      setTarget("");
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="map-page">
      <PageHeader title="Map" meta={data ? `${count(notes.length, "note")} · ${count(data.links.length, "connection")}` : "Loading…"} />
      {notes.length > 0 && (
        <div className="map-controls">
          <Select label="First note" value={source} onChange={setSource} options={[{ value: "", label: "Choose a note…" }, ...options]} />
          <span className="muted">connects to</span>
          <Select label="Second note" value={target} onChange={setTarget} options={[{ value: "", label: "Another note…" }, ...options]} />
          <Button variant="primary" icon={Link2} disabled={!source || !target || source === target} onClick={() => void link()}>
            Connect
          </Button>
        </div>
      )}
      {notes.length > 0 ? (
        <div className="map-canvas">
          <svg viewBox="0 0 900 600" role="img" aria-label="Connected research notes">
            {data!.links.map((l, i) => {
              const a = points.find((p) => p.note.id === l.source);
              const b = points.find((p) => p.note.id === l.target);
              return a && b ? <line key={i} className="map-link" x1={a.x} y1={a.y} x2={b.x} y2={b.y} /> : null;
            })}
            {points.map((p) => (
              <g
                key={p.note.id}
                className="map-node"
                tabIndex={0}
                role="button"
                aria-label={p.note.title}
                onClick={() => openNote(p.note)}
                onKeyDown={(e) => e.key === "Enter" && openNote(p.note)}
                transform={`translate(${p.x},${p.y})`}
              >
                <rect x={-104} y={-30} width={208} height={60} rx={10} />
                <circle cx={-82} cy={0} r={5} />
                <text x={-68} y={5}>
                  {truncate(p.note.title, 24)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : (
        data && <Empty icon={Network} title="Give your ideas a place to meet" text="Create notes, then connect them here." />
      )}
    </div>
  );
}
