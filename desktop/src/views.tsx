import { useEffect, useRef, useState } from "react";
import { api } from "./lib/ipc.ts";
import {
  AudioLines,
  Library,
  Search,
  Users,
  FileText,
  NotebookPen,
  Network,
  Plus,
  ArrowLeft,
  ArrowRight,
  Play,
  Check,
  LoaderCircle,
  FolderOpen,
  RefreshCw,
  ChevronRight,
  HardDrive,
  Cpu,
  Sparkles,
  Clock3,
  CircleAlert,
  GripVertical,
} from "lucide-react";
import type {
  Media,
  Assignment,
  Recording,
  Overview,
  Speaker,
  Note,
  Research,
  Runtime,
  SearchHit,
} from "./lib/types.ts";
export const time = (n: number) => {
  const v = Math.max(0, Math.floor(n || 0));
  return v >= 3600
    ? `${Math.floor(v / 3600)}:${String(Math.floor(v / 60) % 60).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`
    : `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
};
const date = (s: string) =>
  /^\d{8}$/.test(s)
    ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`
    : s || "Undated";
const initials = (s: string) =>
  s
    .split(" ")
    .map((x) => x[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
export function PageHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
export function Empty({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof Library;
  title: string;
  text: string;
}) {
  return (
    <div className="empty">
      <Icon size={32} />
      <h3>{title}</h3>
      <p>{text}</p>
    </div>
  );
}

export function SpeakerView({
  revision,
  onError,
}: {
  revision: number;
  onError: (s: string) => void;
}) {
  const [items, setItems] = useState<Speaker[]>([]);
  const [query, setQuery] = useState("");
  useEffect(() => {
    api
      .speakers()
      .then(setItems)
      .catch((e) => onError(String(e)));
  }, [revision]);
  return (
    <>
      <PageHeading
        eyebrow="FAMILIAR VOICES"
        title="Speakers"
        description="The people who bring your archive to life."
      />
      <div className="library-toolbar">
        <span>{items.length} saved voices</span>
        <input
          aria-label="Find a speaker"
          placeholder="Find a speaker…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="speaker-grid">
        {items
          .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
          .map((s, i) => (
            <article className="panel speaker-card" key={s.id}>
              <span className={`avatar large avatar-${i % 4}`}>
                {initials(s.name)}
              </span>
              <h3>{s.name}</h3>
              <p>
                {s.recordings} recordings · {time(s.airtime)} speaking
              </p>
              {s.notes && <p>{s.notes}</p>}
            </article>
          ))}
      </div>
      {!items.length && (
        <Empty
          icon={Users}
          title="Get to know your archive."
          text="Open a transcript and name a voice to build your speaker library."
        />
      )}
    </>
  );
}

export function Documents({
  data,
  onImport,
  onError,
}: {
  data: Research["docs"];
  onImport: () => void;
  onError: (s: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [doc, setDoc] = useState<{ title: string; body: string } | null>(null);
  if (doc)
    return (
      <>
        <button className="back-link" onClick={() => setDoc(null)}>
          <ArrowLeft size={16} /> Documents
        </button>
        <h1>{doc.title}</h1>
        <article className="document-body panel">
          {doc.body ||
            "No indexed text was available for this document. Import the original Markdown file to read it here."}
        </article>
      </>
    );
  return (
    <>
      <PageHeading
        eyebrow="MORE THAN SPOKEN WORDS"
        title="Documents"
        description="Keep your written sources close to the conversation."
        action={
          <button className="primary" onClick={onImport}>
            <Plus size={16} /> Add documents
          </button>
        }
      />
      <div className="library-toolbar">
        <span>{data.length} documents</span>
        <input
          aria-label="Find documents"
          placeholder="Filter titles…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="document-list">
        {data
          .filter((d) => d.title.toLowerCase().includes(query.toLowerCase()))
          .map((d) => (
            <button
              className="document-row panel"
              key={d.id}
              onClick={() =>
                api
                  .document(d.id)
                  .then(setDoc)
                  .catch((e) => onError(String(e)))
              }
            >
              <FileText size={21} />
              <span>
                <b>{d.title}</b>
                <small>{d.length.toLocaleString()} characters</small>
              </span>
              <ChevronRight size={16} />
            </button>
          ))}
      </div>
      {!data.length && (
        <Empty
          icon={FileText}
          title="A home for your sources."
          text="Add Markdown or plain text documents to your archive."
        />
      )}
    </>
  );
}

export function MapView({
  data,
  onOpen,
  onLink,
}: {
  data: Research;
  onOpen: (n: Note) => void;
  onLink: (a: string, b: string) => void;
}) {
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const points = data.notes.map((n, i) => ({
    note: n,
    x:
      450 + 290 * Math.cos((i / data.notes.length) * 2 * Math.PI - Math.PI / 2),
    y:
      300 + 200 * Math.sin((i / data.notes.length) * 2 * Math.PI - Math.PI / 2),
  }));
  return (
    <>
      <PageHeading
        eyebrow="SEE THE CONNECTIONS"
        title="Your research map"
        description="Connect notes and follow an idea back to its source."
      />
      {data.notes.length ? (
        <>
          <div className="map-controls">
            <select
              aria-label="First note"
              value={source}
              onChange={(e) => setSource(e.target.value)}
            >
              <option value="">Choose a note…</option>
              {data.notes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
            <span>connects to</span>
            <select
              aria-label="Second note"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Another note…</option>
              {data.notes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={!source || !target || source === target}
              onClick={() => onLink(source, target)}
            >
              Connect
            </button>
          </div>
          <div className="map-panel panel">
            <svg
              viewBox="0 0 900 600"
              role="img"
              aria-label="Connected research notes"
            >
              {data.links.map((l, i) => {
                const a = points.find((p) => p.note.id === l.source),
                  b = points.find((p) => p.note.id === l.target);
                return a && b ? (
                  <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
                ) : null;
              })}
              {points.map((p) => (
                <g
                  key={p.note.id}
                  tabIndex={0}
                  role="button"
                  aria-label={p.note.title}
                  onClick={() => onOpen(p.note)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(p.note);
                  }}
                  transform={`translate(${p.x},${p.y})`}
                >
                  <rect x={-100} y={-34} width={200} height={68} rx={12} />
                  <circle cx={-76} cy={0} r={5} />
                  <text x={-61} y={5}>
                    {p.note.title.length > 23
                      ? p.note.title.slice(0, 22) + "…"
                      : p.note.title}
                  </text>
                </g>
              ))}
            </svg>
            <p>
              {data.notes.length} notes · {data.links.length} connections ·
              Select a note to explore
            </p>
          </div>
        </>
      ) : (
        <Empty
          icon={Network}
          title="Give your ideas a place to meet."
          text="Create notes, then connect them here."
        />
      )}
    </>
  );
}

export function Settings({
  overview,
  device,
  setDevice,
  onImport,
  onError,
}: {
  overview?: Overview;
  device: string;
  setDevice: (s: string) => void;
  onImport: () => void;
  onError: (s: string) => void;
}) {
  const [runtime, setRuntime] = useState<Runtime>();
  const check = () =>
    api
      .speechStatus()
      .then(setRuntime)
      .catch((e) => onError(String(e)));
  useEffect(() => {
    void check();
  }, []);
  return (
    <>
      <PageHeading
        eyebrow="MAKE IT YOURS"
        title="Settings"
        description="A few clear choices. Everything in its place."
      />
      <div className="settings-grid">
        <section className="panel setting-card">
          <div className="setting-icon">
            <AudioLines size={23} />
          </div>
          <div className="row">
            <h2>Speech</h2>
            <span className={`badge ${runtime?.ready ? "complete" : ""}`}>
              {runtime
                ? runtime.ready
                  ? "Ready"
                  : "Setup needed"
                : "Checking…"}
            </span>
          </div>
          <p>
            Nemotron 3.5 multilingual transcription and Nemotron diarization.
            Saved voices use the same TitaNet matching as your current Concord.
          </p>
          <label>
            Process recordings on
            <select value={device} onChange={(e) => setDevice(e.target.value)}>
              <option value="auto">Automatic · GPU when available</option>
              <option value="cpu">CPU</option>
              <option
                value="vulkan:0"
                disabled={runtime?.device !== "vulkan:0"}
              >
                GPU · Vulkan
              </option>
            </select>
          </label>
          <div className="runtime-facts">
            <span>
              <Cpu size={15} />
              {runtime?.gpu || "CPU processing"}
            </span>
            <span>
              {runtime?.modelsReady ? (
                <Check size={15} />
              ) : (
                <CircleAlert size={15} />
              )}
              Speech models {runtime?.modelsReady ? "available" : "missing"}
            </span>
            <span>
              {runtime?.voiceMatchingReady ? (
                <Check size={15} />
              ) : (
                <CircleAlert size={15} />
              )}
              Voice matching{" "}
              {runtime?.voiceMatchingReady ? "available" : "missing"}
            </span>
          </div>
          {runtime && !runtime.ready && (
            <p className="inline-error">
              This first preview reuses the models and voice environment from
              the Nemotron Concord build. Finish its speech setup, then check
              again.
            </p>
          )}
          <button className="secondary" onClick={check}>
            <RefreshCw size={15} /> Check again
          </button>
        </section>
        <section className="panel setting-card">
          <div className="setting-icon">
            <HardDrive size={23} />
          </div>
          <h2>Your library</h2>
          <p>
            This preview has a separate database and saves new transcripts in
            its own folder. Imported recordings refer to your existing media.
          </p>
          <label>
            Library folder<code>{overview?.dataRoot}</code>
          </label>
          <div className="runtime-facts">
            <span>{overview?.media.toLocaleString()} recordings</span>
            <span>{overview?.speakers} saved voices</span>
          </div>
          <button
            className="secondary"
            disabled={!!overview?.media}
            onClick={onImport}
          >
            <FolderOpen size={15} /> Import Concord database
          </button>
        </section>
      </div>
      <section className="panel coming-next">
        <h3>AI is a separate next step</h3>
        <p>
          Chat and semantic search will have independent provider and model
          settings. This preview uses local word search; it does not send your
          archive to an AI provider.
        </p>
      </section>
    </>
  );
}
