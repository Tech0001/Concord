import { Suspense, lazy, useEffect, useState } from "react";
import { Switch, Route, Link, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import NotFound from "@/pages/not-found";
import PipelineHub from "@/pages/PipelineHub";
import Library from "@/pages/Library";
import Search from "@/pages/Search";
import Clips from "@/pages/Clips";
import AI from "@/pages/AI";
import Speakers from "@/pages/Speakers";
import Status from "@/pages/Status";
import { usePipelineSetup } from "@/hooks/use-pipeline-setup";
import Discover from "@/pages/Discover";
import Watchers from "@/pages/Watchers";
import Docs from "@/pages/Docs";
import Extract from "@/pages/Extract";
import Health from "@/pages/Health";
import Compare from "@/pages/Compare";
import Terminal from "@/pages/Terminal";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import {
  Activity,
  Binoculars,
  Compass,
  Database,
  FileAudio,
  FileText,
  Gauge,
  HeartPulse,
  Map as MapIcon,
  Menu,
  Mic,
  Moon,
  NotebookText,
  PanelLeftClose,
  PanelLeftOpen,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Sparkles,
  SplitSquareHorizontal,
  SquareTerminal,
  Sun,
  Users,
} from "lucide-react";
import { VoiceRecorder } from "@/components/VoiceRecorder";
import { CategoryProvider, useCategory, type Category } from "@/hooks/use-category";
import { SidebarProvider, useSidebar } from "@/hooks/use-sidebar";
import { GlobalCommandPalette } from "@/components/GlobalCommandPalette";
import { PipelineControls } from "@/components/PipelineControls";

const MapPage = lazy(() => import("@/pages/Map"));

// Grouped nav. Items inside a group sit together; a thin divider
// renders between groups in the desktop bar (and a header label in
// the mobile sheet). "Content" = stuff to browse/save, "Analysis" =
// tools that operate on what's already saved, "Ops" = pipeline /
// status surfaces.
const NAV_GROUPS = [
  {
    name: "Content",
    items: [
      { href: "/library",     label: "Library",     icon: Database },
      { href: "/discover",    label: "Discover",    icon: Compass },
      { href: "/watchers",    label: "Watchers",    icon: Binoculars },
      { href: "/search",      label: "Transcripts", icon: SearchIcon },
      { href: "/notes",       label: "Notes",       icon: NotebookText },
      { href: "/docs",        label: "Docs",        icon: FileText },
    ],
  },
  {
    name: "Analysis",
    items: [
      { href: "/speakers",    label: "Speakers",    icon: Users },
      { href: "/map",         label: "Map",         icon: MapIcon },
      { href: "/ai",          label: "AI",          icon: Sparkles },
      { href: "/compare",     label: "Compare",     icon: SplitSquareHorizontal },
    ],
  },
  {
    name: "Ops",
    items: [
      { href: "/pipeline",    label: "Pipeline",    icon: Activity },
      { href: "/status",      label: "Status",      icon: Gauge },
      { href: "/health",      label: "Health",      icon: HeartPulse },
      { href: "/terminal",    label: "Terminal",    icon: SquareTerminal },
      { href: "/extract",     label: "Extract",     icon: FileAudio },
    ],
  },
] as const;

function TopBar() {
  const [location] = useLocation();
  const { theme, toggle, themeName, setThemeName, themes } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);

  // Auto-close the mobile menu whenever the route changes — without this the
  // sheet stays open after a nav link tap, which feels broken on phone.
  useEffect(() => { setMenuOpen(false); }, [location]);

  const themeSelect = (
    <Select value={themeName} onValueChange={setThemeName}>
      <SelectTrigger className="h-8 w-[120px] text-xs" aria-label="Theme">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {themes.map((name) => (
          <SelectItem key={name} value={name} className="text-xs capitalize">
            {name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const themeToggleButton = (
    <Button
      size="icon"
      variant="ghost"
      onClick={toggle}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      className="h-8 w-8"
    >
      {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
    </Button>
  );

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 [-webkit-app-region:drag]">
      <div className="flex h-12 items-center gap-3 px-3 md:px-4 lg:gap-6">
        <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
          <SidebarToggle />
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-foreground text-[11px] font-semibold text-background tracking-tight">
            C
          </span>
          <span className="text-sm font-semibold tracking-tight">
            Concord
          </span>
        </div>

        {/* Spacer — desktop nav lives in the left sidebar now (Sidebar
            component below). Phone still uses the hamburger sheet to
            the right. */}
        <div className="hidden flex-1 md:block" />

        {/* Right-side controls — no-drag so settings/theme/hamburger
            buttons remain clickable inside the draggable header. */}
        <div className="ml-auto flex items-center gap-1 md:ml-0 [-webkit-app-region:no-drag]">
          <PipelineControls />
          <Button
            size="sm"
            variant="ghost"
            className="hidden h-8 gap-2 px-2 text-xs text-muted-foreground sm:inline-flex"
            onClick={() => window.dispatchEvent(new Event("concord:open-command"))}
            title="Search or run a command (Ctrl+K)"
          >
            <SearchIcon className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">Search</span>
            <kbd className="hidden rounded border bg-muted px-1 py-0.5 font-mono text-[9px] lg:inline">Ctrl K</kbd>
          </Button>
          <CategoryToggle />
          <LlmStatusDot />

          {/* Voice-note recorder — sits next to the LLM status dot so it's
              one click away on every page, including mobile (where the
              hamburger replaces the nav links but this row stays visible). */}
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label="Record voice note"
            title="Record voice note"
            onClick={() => setRecorderOpen(true)}
          >
            <Mic className="h-3.5 w-3.5" />
          </Button>
          <VoiceRecorder open={recorderOpen} onOpenChange={setRecorderOpen} />

          {/* Settings + theme controls only fit on md+ — the mobile menu
              repeats them inside the drawer so phone users still have access. */}
          <Link
            href="/pipeline/setup"
            aria-label="Pipeline setup"
            title="Pipeline setup"
            className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground md:inline-flex"
          >
            <SettingsIcon className="h-3.5 w-3.5" />
          </Link>
          <div className="hidden md:block">{themeSelect}</div>
          <div className="hidden md:block">{themeToggleButton}</div>

          {/* Hamburger — phone only. */}
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8 md:hidden" aria-label="Open menu">
                <Menu className="h-4 w-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 p-0">
              <SheetHeader className="border-b p-4">
                <SheetTitle className="text-base">Concord</SheetTitle>
              </SheetHeader>
              <nav className="flex flex-col gap-0.5 p-2">
                {NAV_GROUPS.map((group, groupIdx) => (
                  <div key={group.name} className={cn("flex flex-col gap-0.5", groupIdx > 0 && "mt-2 border-t pt-2")}>
                    <p className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      {group.name}
                    </p>
                    {group.items.map(({ href, label, icon: Icon }) => {
                      const active = location === href || (href === "/pipeline" && location.startsWith("/pipeline/"));
                      return (
                        <SheetClose asChild key={href}>
                          <Link
                            href={href}
                            className={cn(
                              "inline-flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                              active && "bg-secondary text-foreground"
                            )}
                          >
                            <Icon className="h-4 w-4" />
                            <span>{label}</span>
                          </Link>
                        </SheetClose>
                      );
                    })}
                  </div>
                ))}
                <div className="mt-2 flex flex-col gap-0.5 border-t pt-2">
                  <SheetClose asChild>
                    <Link
                      href="/pipeline/setup"
                      className={cn(
                        "inline-flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                        (location === "/settings" || location === "/pipeline/setup") && "bg-secondary text-foreground"
                      )}
                    >
                      <SettingsIcon className="h-4 w-4" />
                      <span>Pipeline setup</span>
                    </Link>
                  </SheetClose>
                </div>
              </nav>
              <div className="space-y-3 border-t p-4">
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Theme</div>
                  {themeSelect}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {theme === "dark" ? "Dark mode" : "Light mode"}
                  </span>
                  {themeToggleButton}
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}

/** Segmented toggle for Personal / Work / Both — the global category
 *  filter that affects every list page. Lives in the top bar so it
 *  reads as a viewing setting, not a per-page filter. */
function CategoryToggle() {
  const { category, setCategory } = useCategory();
  const opts: { value: Category; label: string }[] = [
    { value: "personal", label: "Personal" },
    { value: "work",     label: "Work" },
    { value: "both",     label: "Both" },
  ];
  return (
    <div
      className="hidden md:inline-flex items-center gap-0.5 rounded-md border bg-card p-0.5 text-xs"
      role="radiogroup"
      aria-label="Category filter"
    >
      {opts.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={category === o.value}
          onClick={() => setCategory(o.value)}
          className={cn(
            "rounded px-2 py-0.5 transition-colors",
            category === o.value
              ? "bg-secondary text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function LlmStatusDot() {
  const [status, setStatus] = useState<{ reachable: boolean; latencyMs?: number; errorKind?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      // Abort after 8s. oMLX serializes requests; during a long chat
      // call the /v1/models probe can queue for several seconds before
      // responding. 8s avoids false-negative "unreachable" flicker
      // while still surfacing real failures within one poll cycle.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch("/api/llm/status", { signal: ctl.signal });
        if (!cancelled && r.ok) setStatus(await r.json());
      } catch {
        if (!cancelled) setStatus({ reachable: false, errorKind: "unreachable" });
      } finally {
        clearTimeout(timer);
      }
    };
    probe();
    const id = setInterval(probe, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const color =
    !status              ? "bg-muted" :
    status.reachable     ? "bg-emerald-500" :
    status.errorKind === "http" ? "bg-amber-500" :
                           "bg-zinc-500";
  const title =
    !status              ? "Probing LLM…" :
    status.reachable     ? `LLM reachable${status.latencyMs !== undefined ? ` (${status.latencyMs}ms)` : ""}` :
    status.errorKind === "config"      ? "LLM not configured" :
    status.errorKind === "unreachable" ? "LLM unreachable" :
    status.errorKind === "http"        ? "LLM auth/HTTP error" :
                                         "LLM error";

  return (
    <Link href="/ai" aria-label={title} title={title} className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-secondary">
      <span className={cn("inline-block h-2 w-2 rounded-full", color)} />
    </Link>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Library} />
      <Route path="/status" component={Status} />
      <Route path="/health" component={Health} />
      <Route path="/terminal" component={Terminal} />
      <Route path="/pipeline"><PipelineHub /></Route>
      <Route path="/pipeline/setup"><PipelineHub section="setup" /></Route>
      <Route path="/pipeline/ai"><PipelineHub section="ai" /></Route>
      <Route path="/library" component={Library} />
      <Route path="/discover" component={Discover} />
      <Route path="/watchers" component={Watchers} />
      <Route path="/docs" component={Docs} />
      <Route path="/search" component={Search} />
      <Route path="/notes" component={Clips} />
      <Route path="/clips" component={Clips} />
      <Route path="/speakers" component={Speakers} />
      <Route path="/extract" component={Extract} />
      <Route path="/ai" component={AI} />
      <Route path="/compare" component={Compare} />
      <Route path="/settings"><PipelineHub section="setup" /></Route>
      <Route path="/setup/transcription"><PipelineHub section="setup" /></Route>
      <Route path="/map">
        <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading map...</div>}>
          <MapPage />
        </Suspense>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

/** First-use setup is stored on the server, so every window uses the same gate. */
function PipelineSetupGate({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const { data: setup, error, refetch } = usePipelineSetup();
  const inSetup = location.startsWith("/pipeline") || location === "/settings" || location === "/setup/transcription";
  const troubleshooting = location === "/health" || location === "/terminal";
  useEffect(() => {
    if (setup && !setup.ready && !inSetup && !troubleshooting) navigate("/pipeline/setup", { replace: true });
  }, [setup, inSetup, troubleshooting, navigate]);
  if (troubleshooting) return <>{children}</>;
  if (error) return <div className="space-y-3 p-6"><p>Could not check Pipeline setup. Reconnect to Concord to continue.</p><Button onClick={() => void refetch()}>Retry</Button></div>;
  if (!setup) return <p className="p-6 text-sm text-muted-foreground">Checking Pipeline setup…</p>;
  if (!setup.ready && !inSetup) return null;
  return <>{children}</>;
}

/** Top-bar button that toggles the sidebar between full + rail
 *  states. Hidden on mobile (the hamburger handles nav there). */
function SidebarToggle() {
  const { collapsed, toggle } = useSidebar();
  return (
    <Button
      size="icon"
      variant="ghost"
      onClick={toggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="hidden h-8 w-8 md:inline-flex"
    >
      {collapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
    </Button>
  );
}

/** Left-side primary nav. Two widths controlled by useSidebar():
 *  expanded (200px, icon + label + group headers) vs collapsed
 *  (48px, icons only with tooltips). Mobile still uses the
 *  hamburger sheet in the top bar. */
function Sidebar() {
  const [location] = useLocation();
  const { collapsed } = useSidebar();
  return (
    <aside
      className={cn(
        "hidden md:flex md:shrink-0 md:flex-col md:border-r md:bg-background/40",
        "md:sticky md:top-12 md:h-[calc(100vh-3rem)] md:overflow-y-auto",
        "transition-[width] duration-200 ease-out",
        collapsed ? "md:w-12" : "md:w-[200px]",
      )}
    >
      <nav className={cn("flex flex-col text-sm", collapsed ? "items-center gap-1 py-2" : "gap-3 p-3")}>
        {NAV_GROUPS.map((group, gIdx) => (
          <div key={group.name} className={cn("flex flex-col", collapsed ? "gap-1" : "gap-0.5")}>
            {/* Group label hidden in rail mode; a thin divider
             *  separates groups instead. */}
            {collapsed
              ? gIdx > 0 && <span aria-hidden className="my-1 h-px w-6 self-center bg-border" />
              : (
                <p className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  {group.name}
                </p>
              )}
            {group.items.map(({ href, label, icon: Icon }) => {
              const active = location === href || (href === "/pipeline" && location.startsWith("/pipeline/"));
              return (
                <Link
                  key={href}
                  href={href}
                  title={collapsed ? label : undefined}
                  className={cn(
                    "inline-flex items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                    collapsed ? "h-8 w-8 justify-center" : "h-8 gap-2 px-2",
                    active && "bg-secondary text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  {!collapsed && <span>{label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div
        className={cn(
          "mt-auto shrink-0 border-t text-muted-foreground",
          collapsed ? "px-1 py-3 text-center text-[10px]" : "px-5 py-3 text-xs",
        )}
        title={`Concord v${__APP_VERSION__}`}
        aria-label={`Concord version ${__APP_VERSION__}`}
      >
        {!collapsed && <span>Concord </span>}
        <span className="tabular-nums">v{__APP_VERSION__}</span>
      </div>
    </aside>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <CategoryProvider>
        <SidebarProvider>
          <div className="min-h-screen bg-background text-foreground">
            <TopBar />
            <GlobalCommandPalette />
            <div className="flex">
              <Sidebar />
              <main className="min-w-0 flex-1 pb-12">
                <PipelineSetupGate><Router /></PipelineSetupGate>
              </main>
            </div>
            <Toaster />
          </div>
        </SidebarProvider>
      </CategoryProvider>
    </QueryClientProvider>
  );
}

export default App;
