import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./style.css";
import "./shell/shell.css";
import { Library, NotebookPen, Plus } from "lucide-react";
import type { Job, Note, Overview, Research } from "./lib/types.ts";
import { api } from "./lib/ipc.ts";
import { count } from "./lib/format.ts";
import { useRoute } from "./lib/router.ts";
import { useStoredState } from "./lib/storage.ts";
import { useShortcuts } from "./lib/shortcuts.ts";
import { PHONE, RAIL, useMediaQuery } from "./lib/media-query.ts";
import { ToastProvider, useToast } from "./ui/Toasts.tsx";
import { Empty } from "./ui/Empty.tsx";
import { Button } from "./ui/Button.tsx";
import { AppContext, type AppContextValue } from "./shell/AppContext.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { TabBar } from "./shell/TabBar.tsx";
import { Topbar } from "./shell/Topbar.tsx";
import { CommandPalette } from "./shell/CommandPalette.tsx";
import { ActivityPanel } from "./shell/ActivityPanel.tsx";
import { NoteEditor } from "./notes/NoteEditor.tsx";
import { LibraryPage } from "./library/LibraryPage.tsx";
import { Player, SearchView, SpeakerView, Documents, MapView, Settings, PageHeading } from "./views";

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const toast = useToast();
  const { route, navigate, back } = useRoute();
  const [overview, setOverview] = useState<Overview>();
  const [research, setResearch] = useState<Research>({ notes: [], links: [], docs: [] });
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [device, setDevice] = useStoredState<string>("speech-device", "auto", (v) => typeof v === "string");
  const [note, setNote] = useState<Note | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useStoredState("sidebar-collapsed-v1", false, (v) => typeof v === "boolean");
  const narrow = useMediaQuery(RAIL);
  const phone = useMediaQuery(PHONE);
  const available = api.available();
  const lastJobs = useRef("");

  useEffect(() => {
    if (!available) return;
    api.overview().then(setOverview).catch(toast.error);
    api.research().then(setResearch).catch(toast.error);
  }, [available, revision, toast]);

  // Poll quickly while a job runs, slowly otherwise; refresh data when job states change.
  useEffect(() => {
    if (!available) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const data = await api.jobs();
        if (!alive) return;
        setJobs(data);
        const signature = data.map((j) => j.id + j.status).join();
        if (lastJobs.current && signature !== lastJobs.current) refresh();
        lastJobs.current = signature;
        timer = window.setTimeout(poll, data.some((j) => j.status === "running") ? 1500 : 5000);
      } catch (e) {
        if (alive) toast.error(e);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [available, refresh, toast]);

  useShortcuts([{ key: "k", mod: true, global: true, run: () => setPaletteOpen((v) => !v) }]);

  const pageKey = route.page === "recording" ? `recording:${route.id}` : route.page === "documents" ? `documents:${route.id ?? ""}` : route.page;
  useEffect(() => {
    if (route.page !== "library") window.scrollTo(0, 0);
  }, [pageKey, route.page]);

  const activeJob = jobs.find((j) => j.status === "running");
  const transcribe = useCallback(
    async (id: string) => {
      try {
        await api.transcribe(id, device);
        toast.info("Transcription started", { label: "Activity", run: () => setActivityOpen(true) });
        refresh();
      } catch (e) {
        toast.error(e);
      }
    },
    [device, refresh, toast],
  );
  const addRecordings = useCallback(async () => {
    try {
      const paths = await api.pickMedia();
      if (!paths.length) return;
      const n = await api.importMedia(paths);
      refresh();
      navigate({ page: "library" });
      toast.success(`${count(n, "recording")} added`);
    } catch (e) {
      toast.error(e);
    }
  }, [navigate, refresh, toast]);
  const importLegacy = useCallback(
    async (path?: string) => {
      try {
        const chosen = path || (await api.pickDatabase())[0];
        if (!chosen) return;
        const result = await api.importLegacy(chosen);
        setOverview(result);
        refresh();
        toast.success(`Imported ${count(result.media, "recording")} and ${count(result.speakers, "saved voice")}`);
      } catch (e) {
        toast.error(e);
      }
    },
    [refresh, toast],
  );

  const context = useMemo<AppContextValue>(
    () => ({
      route,
      navigate,
      back,
      overview,
      revision,
      refresh,
      jobs,
      activeJob,
      device,
      setDevice,
      transcribe,
      openNote: setNote,
      openPalette: () => setPaletteOpen(true),
      openActivity: () => setActivityOpen(true),
      addRecordings,
      importLegacy,
      pageTitle,
      setPageTitle,
    }),
    [route, navigate, back, overview, revision, refresh, jobs, activeJob, device, setDevice, transcribe, addRecordings, importLegacy, pageTitle],
  );

  if (!available)
    return (
      <div className="unavailable">
        <Empty icon={Library} title="Open Concord Next as a desktop app" text="Run it with pnpm --dir desktop desktop, or add ?mock to preview with sample data." />
      </div>
    );

  const onError = (e: string) => toast.error(e);
  let page: React.ReactNode;
  switch (route.page) {
    case "recording":
      page = (
        <Player
          id={route.id}
          at={route.at ?? 0}
          revision={revision}
          onBack={back}
          onError={onError}
          onTranscribe={() => void transcribe(route.id)}
          disabled={!!activeJob}
          onRefresh={refresh}
          onNote={setNote}
        />
      );
      break;
    case "search":
      page = (
        <SearchView
          query={route.q}
          setQuery={(q) => navigate({ page: "search", q }, { replace: true })}
          revision={revision}
          onOpen={(id, at) => navigate({ page: "recording", id, at })}
          onError={onError}
        />
      );
      break;
    case "speakers":
      page = <SpeakerView revision={revision} onError={onError} />;
      break;
    case "documents":
      page = (
        <Documents
          data={research.docs}
          onError={onError}
          onImport={async () => {
            try {
              const paths = await api.pickDocuments();
              if (!paths.length) return;
              await api.importDocuments(paths);
              refresh();
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      );
      break;
    case "notes":
      page = (
        <>
          <PageHeading
            eyebrow="COLLECT YOUR THINKING"
            title="Notes"
            description="Keep a thought, a passage, or a connection."
            action={
              <Button variant="primary" icon={Plus} onClick={() => setNote({ title: "", body: "" })}>
                New note
              </Button>
            }
          />
          <div className="note-grid">
            {research.notes.map((n) => (
              <button className="note-card panel" key={n.id} onClick={() => setNote(n)}>
                <NotebookPen size={21} />
                <h3>{n.title}</h3>
                <p>{n.body || n.quote || "Open note"}</p>
              </button>
            ))}
          </div>
        </>
      );
      break;
    case "map":
      page = (
        <MapView
          data={research}
          onOpen={setNote}
          onLink={async (source, target) => {
            try {
              await api.linkNotes(source, target);
              refresh();
            } catch (e) {
              toast.error(e);
            }
          }}
        />
      );
      break;
    case "settings":
      page = <Settings overview={overview} device={device} setDevice={setDevice} onImport={() => void importLegacy()} onError={onError} />;
      break;
    default:
      page = <LibraryPage />;
  }

  return (
    <AppContext.Provider value={context}>
      <div className="shell" data-rail={!phone && (collapsed || narrow)}>
        {!phone && <Sidebar rail={collapsed || narrow} canCollapse={!narrow} onToggle={() => setCollapsed((v) => !v)} />}
        <main className="main">
          <Topbar onAdd={() => void addRecordings()} />
          <div className="page" key={pageKey}>
            {page}
          </div>
        </main>
        {phone && <TabBar />}
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onAdd={() => void addRecordings()} />
      <ActivityPanel open={activityOpen} onOpenChange={setActivityOpen} jobs={jobs} />
      {note && <NoteEditor note={note} onClose={() => setNote(null)} />}
    </AppContext.Provider>
  );
}
