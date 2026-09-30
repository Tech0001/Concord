import { FileText, Library, Network, NotebookPen, Search, Users, type LucideIcon } from "lucide-react";
import type { Page, Route } from "../lib/router.ts";

export type NavItem = { page: Page; label: string; icon: LucideIcon; route: Route };

export const ARCHIVE: NavItem[] = [
  { page: "library", label: "Library", icon: Library, route: { page: "library" } },
  { page: "search", label: "Search", icon: Search, route: { page: "search", q: "" } },
  { page: "documents", label: "Documents", icon: FileText, route: { page: "documents" } },
  { page: "notes", label: "Notes", icon: NotebookPen, route: { page: "notes" } },
];
export const ANALYSIS: NavItem[] = [
  { page: "speakers", label: "Speakers", icon: Users, route: { page: "speakers" } },
  { page: "map", label: "Map", icon: Network, route: { page: "map" } },
];

export const PAGE_TITLES: Record<Page, string> = {
  library: "Library",
  recording: "Recording",
  search: "Search",
  documents: "Documents",
  notes: "Notes",
  speakers: "Speakers",
  map: "Map",
  settings: "Settings",
};

/** The nav section a route belongs to (a recording belongs to the Library). */
export function sectionOf(page: Page): Page {
  return page === "recording" ? "library" : page;
}
