import { Suspense, lazy } from "react";
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
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/use-theme";
import {
  Activity,
  Bookmark,
  Database,
  Map as MapIcon,
  Moon,
  Search as SearchIcon,
  Sun,
} from "lucide-react";

const MapPage = lazy(() => import("@/pages/Map"));

const NAV_ITEMS = [
  { href: "/library", label: "Library", icon: Database },
  { href: "/search", label: "Search", icon: SearchIcon },
  { href: "/clips", label: "Clips", icon: Bookmark },
  { href: "/map", label: "Map", icon: MapIcon },
  { href: "/pipeline", label: "Pipeline", icon: Activity },
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

function Router() {
  return (
    <Switch>
      <Route path="/" component={Library} />
      <Route path="/pipeline" component={Pipeline} />
      <Route path="/library" component={Library} />
      <Route path="/search" component={Search} />
      <Route path="/clips" component={Clips} />
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
