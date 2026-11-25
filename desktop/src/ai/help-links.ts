import type { Route } from "../lib/router.ts";
/** Exact allowlist: generated links can navigate, never invoke an operation or open a file. */
export const HELP_LINKS: Record<string, Route | "health"> = {
  "#/library": { page: "library" },
  "#/search": { page: "search", q: "" },
  "#/search?mode=meaning": { page: "search", q: "", mode: "meaning" },
  "#/documents": { page: "documents" },
  "#/speakers": { page: "speakers" },
  "#/notes": { page: "notes" },
  "#/map": { page: "map" },
  "concord:health": "health",
  ...Object.fromEntries(
    (["speech", "recordings", "ai"] as const).map((step) => [
      `#/setup?step=${step}&return=ai`,
      { page: "setup", step, returnTo: "ai" },
    ]),
  ),
  ...Object.fromEntries(
    (["general", "ai", "speech", "downloads"] as const).map((section) => [
      `#/settings?section=${section}`,
      { page: "settings", section },
    ]),
  ),
  "#/activity": { page: "activity" },
  "#/activity?tab=health": { page: "activity", tab: "health" },
  "#/activity?tab=logs": { page: "activity", tab: "logs" },
  "#/activity?tab=backups": { page: "activity", tab: "backups" },
  "#/tools?tab=extract": { page: "tools", tab: "extract" },
  "#/tools?tab=record": { page: "tools", tab: "record" },
} as Record<string, Route | "health">;
export const PENDING_HELP = "concord.pendingHelp";
