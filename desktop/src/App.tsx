import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Library,
  Search,
  Users,
  FileText,
  NotebookPen,
  Network,
  Settings2,
  Plus,
  Play,
  Check,
  X,
  LoaderCircle,
  ChevronRight,
  CircleAlert,
} from "lucide-react";
import icon from "../../assets/brand/concord-icon.svg";
import wordmark from "../../assets/brand/concord-wordmark.svg";
import type { Overview, Note, Research, Job } from "./types";
import {
  LibraryView,
  Player,
  SearchView,
  SpeakerView,
  Documents,
  MapView,
  Settings,
  PageHeading,
  Empty,
} from "./views";

type Page =
  "library" | "search" | "speakers" | "docs" | "notes" | "map" | "settings";
const navigation = [
  { id: "library", name: "Library", icon: Library },
  { id: "search", name: "Search", icon: Search },
  { id: "speakers", name: "Speakers", icon: Users },
  { id: "docs", name: "Documents", icon: FileText },
  { id: "notes", name: "Notes", icon: NotebookPen },
  { id: "map", name: "Map", icon: Network },
] as const;

export default function App() {
  const [page, setPage] = useState<Page>("library");
  const [overview, setOverview] = useState<Overview>();
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ id: string; at: number } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [research, setResearch] = useState<Research>({
    notes: [],
    links: [],
    docs: [],
  });
  const [note, setNote] = useState<Note | null>(null);
  const [device, setDevice] = useState(
    () => localStorage.getItem("speech-device") || "auto",
  );
  const [jobOpen, setJobOpen] = useState(false);
  const lastJobStates = useRef("");
  const refresh = () => setRevision((v) => v + 1);
  const act = async (fn: () => Promise<void>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!isTauri()) {
      setError(
        "Open Concord Next as a desktop app with pnpm --dir desktop desktop.",
      );
      return;
    }
    invoke<Overview>("overview")
      .then(setOverview)
      .catch((e) => setError(String(e)));
    invoke<Research>("research")
      .then(setResearch)
      .catch((e) => setError(String(e)));
  }, [revision]);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const poll = () =>
      invoke<Job[]>("jobs")
        .then((data) => {
          if (!alive) return;
          setJobs(data);
          const signature = data.map((j) => j.id + j.status).join();
          if (lastJobStates.current && signature !== lastJobStates.current)
            refresh();
          lastJobStates.current = signature;
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  const go = (p: Page) => {
    setPage(p);
    setSelected(null);
  };
  const addMedia = () =>
    act(async () => {
      const result = await open({
        multiple: true,
        title: "Add recordings",
        filters: [
          {
            name: "Audio and video",
            extensions: [
              "mp4",
              "mkv",
              "webm",
              "mov",
              "ogg",
              "wav",
              "mp3",
              "m4a",
              "flac",
              "aac",
              "opus",
            ],
          },
        ],
      });
      if (!result) return;
      const count = await invoke<number>("import_media", {
        paths: Array.isArray(result) ? result : [result],
      });
      refresh();
      go("library");
      setNotice(`${count} recordings added`);
    });
  const importLegacy = (path?: string) =>
    act(async () => {
      const chosen =
        path ||
        (await open({
          title: "Choose your Concord library database",
          filters: [
            {
              name: "Concord library",
              extensions: ["db", "sqlite", "sqlite3"],
            },
          ],
        }));
      if (!chosen || Array.isArray(chosen)) return;
      const result = await invoke<Overview>("import_legacy", { path: chosen });
      setOverview(result);
      refresh();
      setNotice(
        `Imported ${result.media.toLocaleString()} recordings and ${result.speakers} saved voices`,
      );
    });
  const start = (id: string) =>
    act(async () => {
      await invoke("transcribe", { id, device });
      setJobOpen(true);
      setNotice("Transcription started");
    });
  const saveNote = () =>
    act(async () => {
      if (!note) return;
      await invoke("save_note", { note });
      setNote(null);
      refresh();
      setNotice("Note saved");
    });
  const active = jobs.find((j) => j.status === "running");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go("library");
          }}
        >
          <img src={wordmark} alt="Concord" />
          <span className="edition">NEXT · PREVIEW</span>
        </a>
        <div className="nav-label">YOUR ARCHIVE</div>
        <nav>
          {navigation.map((n) => (
            <button
              key={n.id}
              className={page === n.id ? "nav active" : "nav"}
              onClick={() => go(n.id)}
            >
              <n.icon size={18} />
              <span>{n.name}</span>
              {n.id === "library" && overview && (
                <small>{overview.media.toLocaleString()}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className="nav" onClick={() => setJobOpen(!jobOpen)}>
            {active ? (
              <LoaderCircle size={18} className="spin" />
            ) : (
              <Check size={18} />
            )}
            <span>{active ? "Processing recording" : "All activity"}</span>
          </button>
          <button
            className={page === "settings" ? "nav active" : "nav"}
            onClick={() => go("settings")}
          >
            <Settings2 size={18} />
            <span>Settings</span>
          </button>
          <div className="local-status">
            <i className="live-dot" /> Local archive <span>v0.1</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            Your archive <ChevronRight size={14} />
            <b>{navigation.find((n) => n.id === page)?.name || "Settings"}</b>
          </div>
          <form
            className="global-search"
            onSubmit={(e) => {
              e.preventDefault();
              go("search");
            }}
          >
            <Search size={16} />
            <input
              aria-label="Search transcripts"
              placeholder="Find a passage in your archive…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>↵</kbd>
          </form>
          <button className="primary" onClick={addMedia} disabled={busy}>
            <Plus size={16} /> Add recordings
          </button>
        </header>
        {error && (
          <div className="alert error" role="alert">
            <CircleAlert size={18} />
            <span>{error}</span>
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {notice && (
          <div className="toast" role="status">
            <Check size={16} />
            {notice}
          </div>
        )}
        {busy && (
          <div className="busy-line" role="status">
            <LoaderCircle size={14} className="spin" /> Working…
          </div>
        )}
        <div className="page">
          {selected ? (
            <Player
              id={selected.id}
              at={selected.at}
              revision={revision}
              onBack={() => setSelected(null)}
              onError={setError}
              onTranscribe={() => start(selected.id)}
              disabled={!!active || busy}
              onRefresh={refresh}
              onNote={setNote}
            />
          ) : (
            <>
              {page === "library" && (
                <>
                  <PageHeading
                    eyebrow="A PLACE FOR EVERY CONVERSATION"
                    title="Your library"
                    description="Listen again. Find the words that matter."
                  />
                  {overview?.media === 0 ? (
                    <section className="welcome panel">
                      <img src={icon} alt="Concord" />
                      <h2>Bring your archive along.</h2>
                      <p>
                        Import your existing Concord library and saved voices,
                        or start with a recording.
                      </p>
                      <p className="muted">
                        Concord Next keeps its own library. Your original app
                        and files stay available.
                      </p>
                      <div className="actions">
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => importLegacy(overview.legacyDatabase)}
                        >
                          <Library size={17} /> Import Concord library
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => importLegacy()}
                        >
                          Choose database…
                        </button>
                        <button className="ghost" onClick={addMedia}>
                          Add a recording
                        </button>
                      </div>
                    </section>
                  ) : (
                    <LibraryView
                      revision={revision}
                      onOpen={(id) => setSelected({ id, at: 0 })}
                      onError={setError}
                    />
                  )}
                </>
              )}
              {page === "search" && (
                <SearchView
                  query={query}
                  setQuery={setQuery}
                  revision={revision}
                  onOpen={(id, at) => setSelected({ id, at })}
                  onError={setError}
                />
              )}
              {page === "speakers" && (
                <SpeakerView revision={revision} onError={setError} />
              )}
              {page === "docs" && (
                <Documents
                  data={research.docs}
                  onError={setError}
                  onImport={() =>
                    act(async () => {
                      const paths = await open({
                        multiple: true,
                        filters: [
                          {
                            name: "Text and Markdown",
                            extensions: ["md", "txt", "markdown"],
                          },
                        ],
                      });
                      if (paths) {
                        await invoke("import_documents", {
                          paths: Array.isArray(paths) ? paths : [paths],
                        });
                        refresh();
                      }
                    })
                  }
                />
              )}
              {page === "notes" && (
                <>
                  <PageHeading
                    eyebrow="COLLECT YOUR THINKING"
                    title="Notes"
                    description="Keep a thought, a passage, or a connection."
                    action={
                      <button
                        className="primary"
                        onClick={() => setNote({ title: "", body: "" })}
                      >
                        <Plus size={16} /> New note
                      </button>
                    }
                  />
                  <div className="note-grid">
                    {research.notes.map((n) => (
                      <button
                        className="note-card panel"
                        key={n.id}
                        onClick={() => setNote(n)}
                      >
                        <NotebookPen size={21} />
                        <h3>{n.title}</h3>
                        <p>{n.body || n.quote || "Open note"}</p>
                        {n.media_id && (
                          <span className="subtle-tag">
                            Linked to a recording
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {!research.notes.length && (
                    <Empty
                      icon={NotebookPen}
                      title="A little space to think."
                      text="Save a passage from a transcript, or start a note here."
                    />
                  )}
                </>
              )}
              {page === "map" && (
                <MapView
                  data={research}
                  onOpen={setNote}
                  onLink={(source, target) =>
                    act(async () => {
                      await invoke("link_notes", { source, target });
                      refresh();
                    })
                  }
                />
              )}
              {page === "settings" && (
                <Settings
                  overview={overview}
                  device={device}
                  setDevice={(v) => {
                    setDevice(v);
                    localStorage.setItem("speech-device", v);
                  }}
                  onImport={() => importLegacy()}
                  onError={setError}
                />
              )}
            </>
          )}
        </div>
      </main>
      {jobOpen && (
        <aside className="activity panel">
          <div className="row">
            <h3>Activity</h3>
            <button
              className="icon-button"
              aria-label="Close activity"
              onClick={() => setJobOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          {!jobs.length && (
            <p className="muted">New transcription jobs will appear here.</p>
          )}
          {jobs.map((j) => (
            <div className="job" key={j.id}>
              <div className="row">
                <b>{j.title}</b>
                <span className={`badge ${j.status}`}>{j.status}</span>
              </div>
              <p>{j.message}</p>
              {j.status === "running" && (
                <button
                  className="ghost"
                  onClick={() =>
                    act(async () => {
                      await invoke("cancel_transcription");
                    })
                  }
                >
                  Cancel processing
                </button>
              )}
            </div>
          ))}
        </aside>
      )}
      {note && (
        <div className="modal-backdrop" onClick={() => setNote(null)}>
          <section
            className="note-editor panel"
            role="dialog"
            aria-modal="true"
            aria-label="Edit note"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row">
              <span className="eyebrow">RESEARCH NOTE</span>
              <button
                className="icon-button"
                aria-label="Close note"
                onClick={() => setNote(null)}
              >
                <X size={18} />
              </button>
            </div>
            <input
              className="note-title"
              aria-label="Note title"
              placeholder="Give this thought a title"
              value={note.title}
              onChange={(e) => setNote({ ...note, title: e.target.value })}
            />
            {note.quote && <blockquote>{note.quote}</blockquote>}
            <textarea
              aria-label="Note body"
              placeholder="What stands out to you?"
              value={note.body}
              onChange={(e) => setNote({ ...note, body: e.target.value })}
            />
            <div className="actions">
              {note.media_id && (
                <button
                  className="secondary"
                  onClick={() => {
                    setSelected({ id: note.media_id!, at: note.start || 0 });
                    setNote(null);
                  }}
                >
                  <Play size={15} /> Open source
                </button>
              )}
              <button
                className="primary"
                disabled={!note.title.trim() || busy}
                onClick={saveNote}
              >
                Save note
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
