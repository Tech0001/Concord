import {
  Activity,
  MessageCircle,
  Wrench,
  FileText,
  Library,
  Network,
  NotebookPen,
  Search,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Page, Route } from "../lib/router.ts";

export type NavItem = {
  page: Page;
  label: string;
  icon: LucideIcon;
  route: Route;
};

export const ARCHIVE: NavItem[] = [
  {
    page: "library",
    label: "Library",
    icon: Library,
    route: { page: "library" },
  },
  {
    page: "search",
    label: "Search",
    icon: Search,
    route: { page: "search", q: "" },
  },
  {
    page: "notes",
    label: "Notes",
    icon: NotebookPen,
    route: { page: "notes" },
  },
  {
    page: "documents",
    label: "Docs",
    icon: FileText,
    route: { page: "documents" },
  },
];
export const ANALYSIS: NavItem[] = [
  {
    page: "speakers",
    label: "Speakers",
    icon: Users,
    route: { page: "speakers" },
  },
  { page: "ai", label: "AI", icon: MessageCircle, route: { page: "ai" } },
  { page: "map", label: "Map", icon: Network, route: { page: "map" } },
];

export const ACTIVITY: NavItem = { page: "activity", label: "Activity", icon: Activity, route: { page: "activity" } };
/** Recording and audio extraction; reached from Add, a recording's menu and the palette rather than the sidebar. */
export const TOOLS: NavItem = { page: "tools", label: "Tools", icon: Wrench, route: { page: "tools" } };

export const PAGE_TITLES: Record<Page, string> = {
  library: "Library",
  recording: "Recording",
  search: "Search",
  documents: "Documents",
  notes: "Notes",
  speakers: "Speakers",
  map: "Map",
  ai: "AI",
  settings: "Settings",
  activity: "Activity",
  tools: "Tools",
  setup: "Setup",
};

/** The nav section a route belongs to (a recording belongs to the Library). */
export function sectionOf(page: Page): Page {
  return page === "recording" ? "library" : page;
}
