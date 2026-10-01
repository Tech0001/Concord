import { PopoutProvider } from "./player/PopoutContext.tsx";
import { ToolsPage } from "./tools/ToolsPage.tsx";
import { ToolsProvider } from "./tools/ToolsContext.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./shell/shell.css";
import { Library } from "lucide-react";
import type { Category, Job, Note, Overview } from "./lib/types.ts";
import { api } from "./lib/ipc.ts";
import { count } from "./lib/format.ts";
import { useRoute } from "./lib/router.ts";
import { readStored, useStoredState } from "./lib/storage.ts";
import { useShortcuts } from "./lib/shortcuts.ts";
import { PHONE, RAIL, useMediaQuery } from "./lib/media-query.ts";
import { ToastProvider, useToast } from "./ui/Toasts.tsx";
import { Empty } from "./ui/Empty.tsx";
import { AppContext, type AppContextValue } from "./shell/AppContext.tsx";
import { Sidebar, SidebarDrawer } from "./shell/Sidebar.tsx";
import { TabBar } from "./shell/TabBar.tsx";
import { Topbar } from "./shell/Topbar.tsx";
import { CommandPalette } from "./shell/CommandPalette.tsx";
import { ActivityPanel } from "./shell/ActivityPanel.tsx";
import { NoteEditor } from "./notes/NoteEditor.tsx";
import { PipelinePage } from "./pipeline/PipelinePage.tsx";
import { isCategory } from "./library/model.ts";
import { LibraryPage } from "./library/LibraryPage.tsx";
import { PlayerPage } from "./player/PlayerPage.tsx";
import { AiPage } from "./ai/AiPage.tsx";
import { SearchPage } from "./search/SearchPage.tsx";
import { SpeakersPage } from "./speakers/SpeakersPage.tsx";
import { DocumentsPage } from "./documents/DocumentsPage.tsx";
import { NotesPage } from "./notes/NotesPage.tsx";
import { MapPage } from "./map/MapPage.tsx";
import { SettingsPage } from "./settings/SettingsPage.tsx";
import { SetupPage } from "./setup/SetupPage.tsx";
import { SpeechPrompt } from "./setup/SpeechPrompt.tsx";
import type { SetupStatus } from "./setup/types.ts";

export default function App() {
  return (
    <ToastProvider>
      <ToolsProvider><PopoutProvider><Shell /></PopoutProvider></ToolsProvider>
    </ToastProvider>
  );
}

function Shell() {
  const toast = useToast();
  const { route, navigate, back } = useRoute();
  const [overview, setOverview] = useState<Overview>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const [category, setCategory] = useStoredState<Category>("archive-category-v1", "", isCategory);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [device, setDeviceState] = useState("auto");
  const [setup, setSetup] = useState<SetupStatus>();
  const setupRef = useRef<SetupStatus>(undefined);
  setupRef.current = setup;
  const [speechPrompt, setSpeechPrompt] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useStoredState("sidebar-collapsed-v1", false, (v) => typeof v === "boolean");
  const narrow = useMediaQuery(RAIL);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const phone = useMediaQuery(PHONE);
  const available = api.available();
  const lastJobs = useRef("");

  useEffect(() => {
    if (!available) return;
    api.overview().then(setOverview).catch(toast.error);
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
        setJobs((old) => (JSON.stringify(old) === JSON.stringify(data) ? old : data));
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

  // The speech device lives in the backend. Carry over a choice saved by older builds once.
  useEffect(() => {
    if (!available) return;
    void (async () => {
      try {
        let value = await api.speechDevice();
        const old = readStored<string | null>("speech-device", null, (v) => typeof v === "string");
        if (old && old !== value && value === "auto") {
          await api.setSpeechDevice(old);
          value = old;
        }
        setDeviceState(value);
      } catch (e) {
        toast.error(e);
      } finally {
        localStorage.removeItem("speech-device");
      }
    })();
  }, [available, toast]);
  const setDevice = useCallback(
    (value: string) => {
      setDeviceState(value);
      api.setSpeechDevice(value).then(() => api.setupStatus().then(setSetup)).catch(toast.error);
    },
    [toast],
  );

  // Setup readiness: quick while something downloads or setup is open, slow otherwise.
  const onSetup = route.page === "setup";
  const refreshSetup = useCallback(async () => {
    try {
      const next = await api.setupStatus();
      setSetup((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    } catch (e) {
      toast.error(e);
    }
  }, [toast]);
  useEffect(() => {
    if (!available) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await api.setupStatus();
        if (!alive) return;
        setSetup((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
        const busy = next.speech.setup.status === "running" || ["waiting", "running"].includes(next.search.download.status);
        timer = window.setTimeout(poll, busy || onSetup ? 1000 : 15000);
      } catch {
        if (alive) timer = window.setTimeout(poll, 15000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [available, onSetup, revision]);

  // Open setup on a fresh install, or where it was left if Concord closed partway through.
  const checkedSetup = useRef(false);
  useEffect(() => {
    if (!setup || checkedSetup.current) return;
    checkedSetup.current = true;
    const p = setup.progress;
    if (!onSetup && !p.completed && (!setup.library.started || p.furthest !== "library")) navigate({ page: "setup" }, { replace: true });
  }, [setup, onSetup, navigate]);

  useShortcuts([{ key: "k", mod: true, global: true, run: () => setPaletteOpen((v) => !v) }]);

  const pageKey =
    route.page === "recording" ? `recording:${route.id}` : route.page === "documents" ? `documents:${route.id ?? ""}` : route.page;
  useEffect(() => {
    if (route.page !== "library") window.scrollTo(0, 0);
  }, [pageKey, route.page]);

  const activeJob = jobs.find((j) => j.status === "running");
  const transcribe = useCallback(
    async (id: string) => {
      const ready = setupRef.current?.speech;
      if (ready && !ready.installed && ready.setup.status !== "running") {
        setSpeechPrompt(id);
        return;
      }
      try {
        await api.transcribe(id, device);
        toast.info(ready && !ready.installed ? "Queued. It starts when the speech engine finishes installing." : "Recording added to the processing queue", {
          label: "Status & Health",
          run: () => setActivityOpen(true),
        });
        setJobs(await api.jobs());
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
      const n = await api.importMedia(paths, category || "personal");
      refresh();
      navigate({ page: "library" });
      toast.success(`${count(n, "recording")} added`);
    } catch (e) {
      toast.error(e);
    }
  }, [navigate, refresh, toast, category]);
  const importLegacy = useCallback(
    async (path?: string) => {
      try {
        const chosen = path || (await api.pickDatabase())[0];
        if (!chosen) return false;
        const result = await api.importLegacy(chosen);
        setOverview(result);
        refresh();
        toast.success(`Imported ${count(result.media, "recording")} and ${count(result.speakers, "saved voice")}`);
        return true;
      } catch (e) {
        toast.error(e);
        return false;
      }
    },
    [refresh, toast],
  );

  const context = useMemo<AppContextValue>(
    () => ({
      category,
      setCategory,
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
      setup,
      refreshSetup,
    }),
    [
      category,
      setCategory,
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
      addRecordings,
      importLegacy,
      pageTitle,
      setup,
      refreshSetup,
    ],
  );

  if (!available)
    return (
      <div className="unavailable">
        <Empty
          icon={Library}
          title="Open Concord Next as a desktop app"
          text="Run it with pnpm --dir desktop desktop, or add ?mock to preview with sample data."
        />
      </div>
    );

  const prompts = speechPrompt && <SpeechPrompt mediaId={speechPrompt} onClose={() => setSpeechPrompt(null)} />;
  if (route.page === "setup")
    return (
      <AppContext.Provider value={context}>
        <SetupPage route={route} />
        <ActivityPanel open={activityOpen} onOpenChange={setActivityOpen} jobs={jobs} onChanged={() => api.jobs().then(setJobs).catch(toast.error)} />
        {prompts}
      </AppContext.Provider>
    );

  let page: React.ReactNode;
  switch (route.page) {
    case "recording":
      page = <PlayerPage id={route.id} at={route.at} />;
      break;
    case "search":
      page = <SearchPage q={route.q} />;
      break;
    case "speakers":
      page = <SpeakersPage id={route.id} />;
      break;
    case "documents":
      page = <DocumentsPage id={route.id} />;
      break;
    case "notes":
      page = <NotesPage />;
      break;
    case "ai":
      page = <AiPage />;
      break;
    case "map":
      page = <MapPage />;
      break;
    case "tools":
      page = <ToolsPage tab={route.tab} source={route.source}/>;
      break;
    case "pipeline":
      page = <PipelinePage tab={route.tab} />;
      break;
    case "settings":
      page = <SettingsPage section={route.section} />;
      break;
    default:
      page = <LibraryPage />;
  }

  return (
    <AppContext.Provider value={context}>
      <div className="shell" data-rail={!phone && (collapsed || narrow)}>
        {!phone && (
          <Sidebar mode={collapsed || narrow ? "rail" : "full"} onToggle={() => (narrow ? setDrawerOpen(true) : setCollapsed((v) => !v))} />
        )}
        <main className="main">
          <Topbar onAdd={() => void addRecordings()} />
          <div className="page" key={pageKey}>
            {page}
          </div>
        </main>
        {phone && <TabBar />}
      </div>
      {!phone && narrow && <SidebarDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onAdd={() => void addRecordings()} />
      <ActivityPanel open={activityOpen} onOpenChange={setActivityOpen} jobs={jobs} onChanged={() => api.jobs().then(setJobs).catch(toast.error)} />
      {note && <NoteEditor note={note} onClose={() => setNote(null)} />}
      {prompts}
    </AppContext.Provider>
  );
}
