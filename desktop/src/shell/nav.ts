import {
  MessageCircle,
  Wrench,
  Workflow,
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

export const OPERATIONS: NavItem[] = [{ page: "pipeline", label: "Pipeline", icon: Workflow, route: { page: "pipeline" } }, {page:"tools",label:"Tools",icon:Wrench,route:{page:"tools"}}];

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
  pipeline: "Pipeline",
  tools: "Tools",
  setup: "Setup",
};

/** The nav section a route belongs to (a recording belongs to the Library). */
export function sectionOf(page: Page): Page {
  return page === "recording" ? "library" : page;
}
