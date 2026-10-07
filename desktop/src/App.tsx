import {ChatProvider,useChatShell} from "./ai/ChatStore.tsx";
import {AskPanel} from "./ai/AskPanel.tsx";
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
import { ActivityPage } from "./activity/ActivityPage.tsx";
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
import { AddDialog } from "./add/AddDialog.tsx";
import { DropVeil, useDropAndPaste } from "./add/useDropAndPaste.tsx";
import type { AddSeed } from "./add/types.ts";
import type { Source } from "./pipeline/types.ts";
import type { QueueOverview } from "./shell/activity.ts";
import type { SetupStatus } from "./setup/types.ts";

export default function App() {
  return (
    <ToastProvider>
      <ChatProvider><ToolsProvider><PopoutProvider><Shell /></PopoutProvider></ToolsProvider></ChatProvider>
    </ToastProvider>
  );
}

function Shell() {
  const toast = useToast();
  const ask = useChatShell();
  const { route, navigate, back } = useRoute();
  const [overview, setOverview] = useState<Overview>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const [category, setCategory] = useStoredState<Category>("archive-category-v1", "", isCategory);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [queue, setQueue] = useState<QueueOverview>();
  const [sources, setSources] = useState<Source[]>([]);
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
  const lastJobs = useRef<string | null>(null);

  useEffect(() => {
    if (!available) return;
    api.overview().then(setOverview).catch(toast.error);
    api
      .sourcesList()
      .then((next) => setSources((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next)))
      .catch(toast.error);
    api
      .pipelineOverview()
      .then((next) => setQueue((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next)))
      .catch(toast.error);
  }, [available, revision, toast]);

  // A source check runs in the background; follow it until it finishes so its header and the sidebar update.
  useEffect(() => {
    if (!sources.some((s) => s.check_status === "checking")) return;
    const timer = window.setTimeout(refresh, 2500);
    return () => clearTimeout(timer);
  }, [sources, refresh]);

  // Poll quickly while a job runs, slowly otherwise; refresh data when job states change.
  useEffect(() => {
    if (!available) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const [data, counts] = await Promise.all([api.jobs(), api.pipelineOverview()]);
        if (!alive) return;
        setJobs((old) => (JSON.stringify(old) === JSON.stringify(data) ? old : data));
        setQueue((old) => (JSON.stringify(old) === JSON.stringify(counts) ? old : counts));
        const signature = data.map((j) => j.id + j.status).join();
        if (lastJobs.current !== null && signature !== lastJobs.current) refresh();
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

  const openAsk = useCallback((intent?: Parameters<AppContextValue['openAsk']>[0]) => {
    const help = activityOpen || route.page === 'settings' || route.page === 'setup';
    const recording = route.page === 'recording' ? route.id : undefined;
    setActivityOpen(false);
    ask.show({context:help?'help':recording?'recording':'archive',recordingId:recording,recordingTitle:recording?pageTitle??undefined:undefined,...intent});
  },[ask.show,activityOpen,route,pageTitle]);
  useShortcuts([{ key: "k", mod: true, global: true, run: () => setPaletteOpen((v) => !v) },
    { key: "j", mod: true, global: true, run: () => ask.open ? ask.close() : openAsk() }]);
  useEffect(()=>{
    const help=(event:Event)=>{void api.aiHelpPrompt('health',String((event as CustomEvent).detail??'')).then(question=>openAsk({context:'help',question})).catch(toast.error);};
    window.addEventListener('concord:ask-error',help);return()=>window.removeEventListener('concord:ask-error',help);
  },[openAsk,toast]);

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
          label: "Activity",
          run: () => navigate({ page: "activity" }),
        });
        setJobs(await api.jobs());
        refresh();
      } catch (e) {
        toast.error(e);
      }
    },
    [device, refresh, toast],
  );
  // Add collects every drop, pick and paste made while it is open.
  const [adding, setAdding] = useState<AddSeed[] | null>(null);
  const openAdd = useCallback((seed: AddSeed = {}) => setAdding((old) => [...(old ?? []), seed]), []);
  const chooseToAdd = useCallback(
    async (kind: "files" | "folder") => {
      try {
        const paths = kind === "files" ? await api.pickMedia() : [await api.pickFolder("Choose a folder of recordings")].filter((p): p is string => !!p);
        if (paths.length) openAdd({ paths });
      } catch (e) {
        toast.error(e);
      }
    },
    [openAdd, toast],
  );
  const dragging = useDropAndPaste(openAdd);
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
      queue,
      sources,
      activeJob,
      device,
      setDevice,
      transcribe,
      openNote: setNote,
      openPalette: () => setPaletteOpen(true),
      openActivity: () => setActivityOpen(true),
      openAsk,
      openAdd,
      chooseToAdd,
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
      queue,
      sources,
      activeJob,
      device,
      setDevice,
      transcribe,
      openAdd,
      chooseToAdd,
      importLegacy,
      pageTitle,
      setup,
      refreshSetup,
      openAsk,
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

  const prompts = (
    <>
      {speechPrompt && <SpeechPrompt mediaId={speechPrompt} onClose={() => setSpeechPrompt(null)} />}
      {adding && <AddDialog seeds={adding} onClose={() => setAdding(null)} />}
      {dragging && <DropVeil />}
    </>
  );
  if (route.page === "setup")
    return (
      <AppContext.Provider value={context}>
        <SetupPage route={route} />
        <AskPanel/>
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
    case "activity":
      page = <ActivityPage />;
      break;
    case "settings":
      page = <SettingsPage section={route.section} />;
      break;
    default:
      page = <LibraryPage />;
  }

  return (
    <AppContext.Provider value={context}>
      <div className="shell" data-ask-open={ask.open && route.page!=="ai"} data-rail={!phone && (collapsed || narrow)}>
        {!phone && (
          <Sidebar mode={collapsed || narrow ? "rail" : "full"} onToggle={() => (narrow ? setDrawerOpen(true) : setCollapsed((v) => !v))} />
        )}
        <main className="main">
          <Topbar onAdd={() => openAdd()} />
          <div className="page" key={pageKey}>
            {page}
          </div>
        </main>
        {phone && <TabBar />}
      </div>
      {!phone && narrow && <SidebarDrawer open={drawerOpen} onOpenChange={setDrawerOpen} />}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} onAdd={() => openAdd()} />
      <ActivityPanel open={activityOpen} onOpenChange={setActivityOpen} jobs={jobs} onChanged={() => api.jobs().then(setJobs).catch(toast.error)} />
      {note && <NoteEditor note={note} onClose={() => setNote(null)} />}
      {prompts}
      <AskPanel/>
    </AppContext.Provider>
  );
}
