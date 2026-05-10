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
import NotFound from "@/pages/not-found";
import Pipeline from "@/pages/Pipeline";
import Library from "@/pages/Library";
import Search from "@/pages/Search";
import Clips from "@/pages/Clips";
import AI from "@/pages/AI";
import Speakers from "@/pages/Speakers";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import {
  Activity,
  Bookmark,
  Database,
  Map as MapIcon,
  Moon,
  Search as SearchIcon,
  Sparkles,
  Sun,
  Users,
} from "lucide-react";

const MapPage = lazy(() => import("@/pages/Map"));

const NAV_ITEMS = [
  { href: "/library", label: "Library", icon: Database },
  { href: "/search", label: "Search", icon: SearchIcon },
  { href: "/clips", label: "Clips", icon: Bookmark },
  { href: "/speakers", label: "Speakers", icon: Users },
  { href: "/map", label: "Map", icon: MapIcon },
  { href: "/pipeline", label: "Pipeline", icon: Activity },
  { href: "/ai", label: "AI", icon: Sparkles },
] as const;

function TopBar() {
  const [location] = useLocation();
  const { theme, toggle, themeName, setThemeName, themes } = useTheme();

  return (
    <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-6 px-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-foreground text-[11px] font-semibold text-background tracking-tight">
            C
          </span>
          <span className="text-sm font-semibold tracking-tight">
            Concord
          </span>
        </div>
        <nav className="flex flex-1 items-center gap-1 text-sm">
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
        <div className="flex items-center gap-1">
          <LlmStatusDot />
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
          <Button
            size="icon"
            variant="ghost"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="h-8 w-8"
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>
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
      <Route path="/pipeline" component={Pipeline} />
      <Route path="/library" component={Library} />
      <Route path="/search" component={Search} />
      <Route path="/clips" component={Clips} />
      <Route path="/speakers" component={Speakers} />
      <Route path="/ai" component={AI} />
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
