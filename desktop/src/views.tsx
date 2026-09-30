import { useEffect, useRef, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
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
} from "./types";
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

function RecordingCover({ media, index }: { media: Media; index: number }) {
  const element = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSource(null);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void invoke<string | null>("thumbnail_file", { id: media.id })
          .then((path) => {
            if (alive && path) setSource(convertFileSrc(path));
          })
          .catch(() => {});
      },
      { rootMargin: "200px" },
    );
    if (element.current) observer.observe(element.current);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [media.id]);
  return (
    <div
      ref={element}
      className={`cover cover-${index % 4}${source ? " has-artwork" : ""}`}
    >
      {source ? (
        <img
          className="cover-image"
          src={source}
          alt=""
          onError={() => setSource(null)}
        />
      ) : (
        <AudioLines size={38} strokeWidth={1} />
      )}
      <span className="cover-channel">{media.channel}</span>
      <div className="play-circle">
        <Play size={17} fill="currentColor" />
      </div>
      {media.duration > 0 && (
        <span className="duration">{time(media.duration)}</span>
      )}
    </div>
  );
}

export function LibraryView({
  revision,
  onOpen,
  onError,
}: {
  revision: number;
  onOpen: (id: string) => void;
  onError: (s: string) => void;
}) {
  const [items, setItems] = useState<Media[]>([]);
  const [total, setTotal] = useState(0);
  const [channels, setChannels] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [channel, setChannel] = useState("");
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timer = setTimeout(
      () =>
        invoke<{
          items: Media[];
          total: number;
          channels: { channel: string }[];
        }>("library", { query, channel, offset })
          .then((r) => {
            if (alive) {
              setItems(r.items);
              setTotal(r.total);
              setChannels(r.channels.map((c) => c.channel));
            }
          })
          .catch((e) => {
            if (alive) onError(String(e));
          })
          .finally(() => {
            if (alive) setLoading(false);
          }),
      150,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [revision, query, channel, offset]);
  return (
    <>
      <div className="library-toolbar">
        <div className="tabs">
          <button
            className={!channel ? "selected" : ""}
            onClick={() => {
              setChannel("");
              setOffset(0);
            }}
          >
            All recordings
          </button>
          {channels.includes("Meetings") && (
            <button
              className={channel === "Meetings" ? "selected" : ""}
              onClick={() => {
                setChannel("Meetings");
                setOffset(0);
              }}
            >
              Meetings
            </button>
          )}
        </div>
        <div className="filters">
          <select
            aria-label="Filter by collection"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              setOffset(0);
            }}
          >
            <option value="">All collections</option>
            {channels.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <input
            aria-label="Filter recording titles"
            placeholder="Filter titles…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
          />
        </div>
      </div>
      <div className="section-meta">
        <span>
          {total.toLocaleString()} recordings{channel && ` in ${channel}`}
        </span>
        <span>{loading ? "Loading…" : "Newest first"}</span>
      </div>
      <div className="recording-grid">
        {items.map((m, i) => (
          <button
            className="recording-card"
            key={m.id}
            onClick={() => onOpen(m.id)}
          >
            <RecordingCover media={m} index={i} />
            <div className="card-copy">
              <div className="card-date">
                {date(m.date)}
                {m.transcript && (
                  <span>
                    <Check size={12} /> Transcribed
                  </span>
                )}
              </div>
              <h3>{m.title}</h3>
              <div className="card-footer">
                <span className="speaker-stack">
                  <Users size={14} />
                  {m.speaker_count
                    ? `${m.speaker_count} speakers`
                    : m.words
                      ? `${m.words.toLocaleString()} words`
                      : "Ready to transcribe"}
                </span>
                <ArrowRight size={15} />
              </div>
              {m.speaker_names && (
                <p className="names">
                  {m.speaker_names.split(",").join(" · ")}
                </p>
              )}
            </div>
          </button>
        ))}
      </div>
      {!loading && !items.length && (
        <Empty
          icon={Library}
          title="No recordings here yet."
          text="Add a recording or try a different filter."
        />
      )}
      {total > 60 && (
        <div className="pagination">
          <button
            className="secondary"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 60))}
          >
            <ArrowLeft size={15} /> Previous
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 60, total)} of{" "}
            {total.toLocaleString()}
          </span>
          <button
            className="secondary"
            disabled={offset + 60 >= total}
            onClick={() => setOffset(offset + 60)}
          >
            Next <ArrowRight size={15} />
          </button>
        </div>
      )}
    </>
  );
}

function PlayerLayout({
  children,
}: {
  children: [React.ReactNode, React.ReactNode];
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [preferred, setPreferred] = useState(() => {
    try {
      const stored = Number(localStorage.getItem("player-video-width"));
      if (Number.isFinite(stored) && stored >= 20 && stored <= 80)
        return stored;
    } catch {
      /* Storage can be unavailable in a restricted webview. */
    }
    return 64;
  });
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setWidth(element.getBoundingClientRect().width),
    );
    observer.observe(element);
    setWidth(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("player-video-width", String(preferred));
    } catch {
      /* Keep the current split for this session. */
    }
  }, [preferred]);
  const available = width ? Math.max(520, width - 20) : 1200;
  const minimum = Math.max(20, (240 / available) * 100);
  const maximum = Math.min(80, 100 - (280 / available) * 100);
  const clamp = (value: number) => Math.min(maximum, Math.max(minimum, value));
  const split = clamp(preferred);
  const move = (clientX: number) => {
    const bounds = container.current?.getBoundingClientRect();
    if (bounds)
      setPreferred(
        clamp(((clientX - bounds.left - 10) / (bounds.width - 20)) * 100),
      );
  };
  return (
    <div
      ref={container}
      className={`player-layout${dragging ? " is-resizing" : ""}`}
      style={{
        gridTemplateColumns: `minmax(0, ${split}fr) 20px minmax(0, ${100 - split}fr)`,
      }}
    >
      {children[0]}
      <div
        className="player-divider"
        role="separator"
        tabIndex={0}
        aria-label="Resize video and transcript"
        aria-orientation="vertical"
        aria-valuemin={Math.round(minimum)}
        aria-valuemax={Math.round(maximum)}
        aria-valuenow={Math.round(split)}
        aria-valuetext={`Video ${Math.round(split)}%, transcript ${Math.round(100 - split)}%`}
        title="Drag to resize. Double-click to reset. Arrow keys also adjust the split."
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            move(event.clientX);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          setDragging(false);
        }}
        onLostPointerCapture={() => setDragging(false)}
        onDoubleClick={() => setPreferred(64)}
        onKeyDown={(event) => {
          const next = {
            ArrowLeft: clamp(split - 2),
            ArrowRight: clamp(split + 2),
            Home: minimum,
            End: maximum,
            Enter: 64,
          }[event.key];
          if (next === undefined) return;
          event.preventDefault();
          setPreferred(next);
        }}
      >
        <span>
          <GripVertical size={16} />
        </span>
      </div>
      {children[1]}
    </div>
  );
}

export function Player({
  id,
  at,
  revision,
  onBack,
  onError,
  onTranscribe,
  disabled,
  onRefresh,
  onNote,
}: {
  id: string;
  at: number;
  revision: number;
  onBack: () => void;
  onError: (s: string) => void;
  onTranscribe: () => void;
  disabled: boolean;
  onRefresh: () => void;
  onNote: (n: Note) => void;
}) {
  const [data, setData] = useState<Recording>();
  const [source, setSource] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [clock, setClock] = useState(at);
  const [query, setQuery] = useState("");
  const [assigning, setAssigning] = useState<Assignment | null>(null);
  const [name, setName] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let alive = true;
    invoke<Recording>("recording", { id })
      .then((v) => {
        if (alive) setData(v);
      })
      .catch((e) => onError(String(e)));
    return () => {
      alive = false;
    };
  }, [id, revision]);
  useEffect(() => {
    let alive = true;
    setSource("");
    setMediaError("");
    setClock(at);
    invoke<string>("media_file", { id })
      .then((path) => {
        if (alive) setSource(path);
      })
      .catch((e) => {
        if (alive) setMediaError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [id]);
  const seek = (s: number) => {
    if (video.current) {
      video.current.currentTime = s;
      void video.current.play().catch((e) => setMediaError(String(e)));
    }
  };
  if (!data)
    return (
      <div className="empty">
        <LoaderCircle className="spin" /> Loading recording…
      </div>
    );
  const speaker = (local?: string | null) =>
    data.assignments.find((a) => a.local_id === local)?.name ||
    local ||
    "Speaker";
  const segments = data.segments.filter(
    (s) => !query || s.text.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={16} /> Back to archive
      </button>
      <div className="recording-heading">
        <div>
          <p className="eyebrow">
            {data.media.channel} · {date(data.media.date)}
          </p>
          <h1>{data.media.title}</h1>
        </div>
        <button className="primary" disabled={disabled} onClick={onTranscribe}>
          <Sparkles size={16} />
          {data.media.transcript ? "Re-transcribe" : "Transcribe"}
        </button>
      </div>
      <PlayerLayout>
        <div className="player-column">
          <div className="media-panel panel">
            {source ? (
              <video
                ref={video}
                src={source}
                controls
                preload="metadata"
                onLoadedMetadata={() => {
                  if (video.current) video.current.currentTime = at;
                }}
                onTimeUpdate={() => setClock(video.current?.currentTime || 0)}
                onError={() =>
                  setMediaError(
                    "This media format could not be played by the system. Transcription is still available.",
                  )
                }
              />
            ) : (
              <div className="media-unavailable">
                <AudioLines size={38} />
                <p>{mediaError || "Loading media…"}</p>
              </div>
            )}
            {source && mediaError && (
              <p className="inline-error">{mediaError}</p>
            )}
          </div>
          <section className="panel speaker-panel">
            <div className="row">
              <h3>In this recording</h3>
              <span className="muted">{data.assignments.length} voices</span>
            </div>
            <div className="speaker-list">
              {data.assignments.map((a, i) => (
                <button
                  key={a.local_id}
                  onClick={() => {
                    setAssigning(a);
                    setName(a.name || "");
                  }}
                >
                  <span className={`avatar avatar-${i % 4}`}>
                    {a.name ? initials(a.name) : a.local_id}
                  </span>
                  <span>
                    {a.name || `Identify ${a.local_id}`}
                    <small>{time(a.airtime)} speaking</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
            {!data.assignments.length && (
              <p className="muted">
                Transcribe this recording to identify its speakers.
              </p>
            )}
          </section>
          <div className="recording-details">
            <span>
              <Clock3 size={14} />
              {time(data.media.duration)}
            </span>
            <span>{data.media.words.toLocaleString()} words</span>
            <p>
              {data.model?.includes("nemotron")
                ? "Nemotron 3.5 · multilingual"
                : data.model || "Awaiting transcription"}
            </p>
          </div>
        </div>
        <section className="transcript-panel panel">
          <div className="transcript-heading">
            <h3>Transcript</h3>
            <label>
              <Search size={15} />
              <input
                aria-label="Find in transcript"
                placeholder="Find in this recording…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <div className="transcript-scroll">
            {segments.map((s, i) => (
              <div
                className={`transcript-line ${clock >= s.start && clock < s.end ? "current" : ""}`}
                key={`${s.start}-${i}`}
              >
                <button className="timestamp" onClick={() => seek(s.start)}>
                  {time(s.start)}
                </button>
                <div className="passage">
                  <button
                    className="speaker-name"
                    onClick={() => seek(s.start)}
                  >
                    {speaker(s.speaker)}
                  </button>
                  <p onClick={() => seek(s.start)}>{s.text}</p>
                </div>
                <button
                  className="save-passage icon-button"
                  title="Save passage as a note"
                  aria-label={`Save passage at ${time(s.start)}`}
                  onClick={() =>
                    onNote({
                      title: `${data.media.title} · ${time(s.start)}`,
                      body: "",
                      quote: s.text,
                      media_id: id,
                      start: s.start,
                      end: s.end,
                    })
                  }
                >
                  <NotebookPen size={16} />
                </button>
              </div>
            ))}
            {!data.segments.length && (
              <Empty
                icon={AudioLines}
                title="The next conversation starts here."
                text="Choose Transcribe to create a timestamped transcript with speakers."
              />
            )}
            {data.segments.length > 0 && !segments.length && (
              <p className="empty">No passages match your search.</p>
            )}
          </div>
        </section>
      </PlayerLayout>
      {assigning && (
        <div className="modal-backdrop">
          <section className="small-dialog panel">
            <h3>Name this voice</h3>
            <p className="muted">
              Use an existing speaker’s name to connect their recordings.
            </p>
            <input
              autoFocus
              aria-label="Speaker name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div className="actions">
              <button className="secondary" onClick={() => setAssigning(null)}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!name.trim()}
                onClick={() =>
                  invoke("assign_speaker", {
                    id,
                    local: assigning.local_id,
                    name,
                  })
                    .then(() => {
                      setAssigning(null);
                      onRefresh();
                    })
                    .catch((e) => onError(String(e)))
                }
              >
                Save speaker
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export function SearchView({
  query,
  setQuery,
  revision,
  onOpen,
  onError,
}: {
  query: string;
  setQuery: (s: string) => void;
  revision: number;
  onOpen: (id: string, at: number) => void;
  onError: (s: string) => void;
}) {
  const [hits, setHits] = useState<
    {
      id: string;
      title: string;
      channel: string;
      text: string;
      start: number;
      speaker: string;
    }[]
  >([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const timer = setTimeout(
      () =>
        invoke<typeof hits>("search", { query })
          .then((r) => {
            if (alive) setHits(r);
          })
          .catch((e) => {
            if (alive) onError(String(e));
          })
          .finally(() => {
            if (alive) setLoading(false);
          }),
      250,
    );
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query, revision]);
  return (
    <>
      <PageHeading
        eyebrow="FOLLOW A THOUGHT"
        title="Search your archive"
        description="Find spoken words and jump directly to the moment."
      />
      <label className="search-large panel">
        <Search size={22} />
        <input
          aria-label="Search words in transcripts"
          autoFocus
          placeholder="What do you remember hearing?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {loading && <LoaderCircle size={18} className="spin" />}
      </label>
      <div className="section-meta">
        <span>
          {query
            ? `${hits.length}${hits.length === 100 ? "+" : ""} matching passages`
            : "Search across your transcripts"}
        </span>
        <span>Word search · on your computer</span>
      </div>
      <div className="search-results">
        {hits.map((h, i) => (
          <button
            className="search-hit panel"
            key={i}
            onClick={() => onOpen(h.id, h.start)}
          >
            <div className="row">
              <span>
                {h.channel} <ChevronRight size={12} /> {h.title}
              </span>
              <span className="timestamp">
                <Play size={12} />
                {time(h.start)}
              </span>
            </div>
            <p>{h.text}</p>
          </button>
        ))}
      </div>
      {query && !loading && !hits.length && (
        <Empty
          icon={Search}
          title="No matching passages."
          text="Try fewer words or a different spelling."
        />
      )}
      {!query && (
        <Empty
          icon={Search}
          title="A conversation is worth returning to."
          text="Search a name, a phrase, or a word you remember."
        />
      )}
    </>
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
    invoke<Speaker[]>("speakers")
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
                invoke<{ title: string; body: string }>("document", {
                  id: d.id,
                })
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
    invoke<Runtime>("speech_status")
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
