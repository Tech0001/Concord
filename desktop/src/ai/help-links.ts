import type { Route } from "../lib/router.ts";
/** Exact allowlist: generated links can navigate, never invoke an operation or open a file. */
export const HELP_LINKS: Record<string, Route | "health"> = {
  "#/library": {page:"library"}, "#/search": {page:"search",q:""}, "#/documents": {page:"documents"},
  "#/speakers": {page:"speakers"}, "#/notes": {page:"notes"}, "#/map": {page:"map"},
  "concord:health": "health",
  ...Object.fromEntries((["speech","recordings","ai"] as const).map(step=>[`#/setup?step=${step}&return=ai`,{page:"setup",step,returnTo:"ai"}])),
  ...Object.fromEntries((["speech","ai","processing","appearance","library"] as const).map(section=>[`#/settings?section=${section}`,{page:"settings",section}])),
  "#/activity": { page: "activity" },
  "#/tools?tab=extract": {page:"tools",tab:"extract"}, "#/tools?tab=record": {page:"tools",tab:"record"},
} as Record<string, Route | "health">;
export const PENDING_HELP = "concord.pendingHelp";
