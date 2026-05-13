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
import Pipeline from "@/pages/Pipeline";
import Library from "@/pages/Library";
import Search from "@/pages/Search";
import Clips from "@/pages/Clips";
import AI from "@/pages/AI";
import Speakers from "@/pages/Speakers";
import Status from "@/pages/Status";
import Settings from "@/pages/Settings";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import {
  Activity,
  Database,
  Gauge,
  Map as MapIcon,
  Menu,
  Moon,
  NotebookText,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";

const MapPage = lazy(() => import("@/pages/Map"));

const NAV_ITEMS = [
  { href: "/status", label: "Status", icon: Gauge },
  { href: "/library", label: "Library", icon: Database },
  { href: "/search", label: "Search", icon: SearchIcon },
  { href: "/notes", label: "Notes", icon: NotebookText },
  { href: "/speakers", label: "Speakers", icon: Users },
  { href: "/map", label: "Map", icon: MapIcon },
  { href: "/pipeline", label: "Pipeline", icon: Activity },
  { href: "/ai", label: "AI", icon: Sparkles },
] as const;

function TopBar() {
  const [location] = useLocation();
  const { theme, toggle, themeName, setThemeName, themes } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

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
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-3 px-3 md:gap-6 md:px-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-foreground text-[11px] font-semibold text-background tracking-tight">
            C
          </span>
          <span className="text-sm font-semibold tracking-tight">
            Concord
          </span>
        </div>

        {/* Desktop nav — visible md and up. Phone gets the hamburger below.
            no-drag so the nav links are clickable inside the draggable header. */}
        <nav className="hidden flex-1 items-center gap-1 text-sm md:flex [-webkit-app-region:no-drag]">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = location === href;
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-muted-foreground transition-colors hover:text-foreground",
                  active && "bg-secondary text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right-side controls — no-drag so settings/theme/hamburger
            buttons remain clickable inside the draggable header. */}
        <div className="ml-auto flex items-center gap-1 md:ml-0 [-webkit-app-region:no-drag]">
          <LlmStatusDot />

          {/* Settings + theme controls only fit on md+ — the mobile menu
              repeats them inside the drawer so phone users still have access. */}
          <Link
            href="/settings"
            aria-label="Settings"
            title="Settings"
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
                {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
                  const active = location === href;
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
                <SheetClose asChild>
                  <Link
                    href="/settings"
                    className={cn(
                      "inline-flex h-10 items-center gap-3 rounded-md px-3 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground",
                      location === "/settings" && "bg-secondary text-foreground"
                    )}
                  >
                    <SettingsIcon className="h-4 w-4" />
                    <span>Settings</span>
                  </Link>
                </SheetClose>
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
      <Route path="/pipeline" component={Pipeline} />
      <Route path="/library" component={Library} />
      <Route path="/search" component={Search} />
      <Route path="/notes" component={Clips} />
      <Route path="/clips" component={Clips} />
      <Route path="/speakers" component={Speakers} />
      <Route path="/ai" component={AI} />
      <Route path="/settings" component={Settings} />
      <Route path="/map">
        <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">Loading map...</div>}>
          <MapPage />
        </Suspense>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background text-foreground">
        <TopBar />
        <main className="pb-12">
          <Router />
        </main>
        <Toaster />
      </div>
    </QueryClientProvider>
  );
}

export default App;
