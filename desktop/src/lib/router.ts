import { useCallback, useEffect, useState } from "react";
import type { ChatChoice, SetupStep } from "../setup/types.ts";

export const SETTINGS_SECTIONS = ["appearance", "ai", "youtube", "speech", "library", "about"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export const PIPELINE_TABS = ["queue", "batch", "sources", "setup"] as const;
export type PipelineTab = (typeof PIPELINE_TABS)[number];
const SETUP_STEPS: SetupStep[] = ["library", "speech", "recordings", "ai", "look", "ready"];
/** Pages that setup can return to when it was opened from somewhere else. */
const RETURNS = ["library", "ai", "search", "settings"] as const;
const CHATS: ChatChoice[] = ["codex", "claude-code", "chatgpt", "openrouter", "local", "custom"];
const pick = <T extends string>(list: readonly T[], value: string | null): T | undefined =>
  value != null && (list as readonly string[]).includes(value) ? (value as T) : undefined;
/** Drop undefined fields so parsed routes compare equal to the ones they came from. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

export type Route =
  | { page: "library" }
  | { page: "recording"; id: string; at?: number }
  | { page: "search"; q: string }
  | { page: "documents"; id?: string }
  | { page: "speakers"; id?: string }
  | { page: "notes" }
  | { page: "map" }
  | { page: "pipeline"; tab?: PipelineTab }
  | { page: "ai"; context?: "archive" | "help" | "none"; question?: string }
  | { page: "settings"; section?: SettingsSection }
  | { page: "setup"; step?: SetupStep; returnTo?: (typeof RETURNS)[number]; chat?: ChatChoice }
  | { page: "tools"; tab?: "extract" | "record"; source?: string };
export type Page = Route["page"];

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const q = raw.indexOf("?");
  const path = q < 0 ? raw : raw.slice(0, q);
  const params = new URLSearchParams(q < 0 ? "" : raw.slice(q + 1));
  const slash = path.indexOf("/");
  const head = slash < 0 ? path : path.slice(0, slash);
  const tail = slash < 0 ? "" : path.slice(slash + 1);
  switch (head) {
    case "recording": {
      if (!tail) return { page: "library" };
      const id = decodeURIComponent(tail);
      const at = Number(params.get("t"));
      return params.has("t") && Number.isFinite(at) && at >= 0 ? { page: "recording", id, at } : { page: "recording", id };
    }
    case "tools":
      return defined({page:"tools",tab:params.get("tab")==="record"?"record":"extract",source:params.get("source")??undefined});
    case "search":
      return { page: "search", q: params.get("q") ?? "" };
    case "documents":
      return tail ? { page: "documents", id: decodeURIComponent(tail) } : { page: "documents" };
    case "speakers":
      return tail ? { page: "speakers", id: decodeURIComponent(tail) } : { page: "speakers" };
    case "settings":
      return defined({ page: "settings", section: pick(SETTINGS_SECTIONS, params.get("section")) });
    case "pipeline":
      return defined({ page: "pipeline", tab: pick(PIPELINE_TABS, params.get("tab")) });
    case "setup":
      return defined({
        page: "setup",
        step: pick(SETUP_STEPS, params.get("step")),
        returnTo: pick(RETURNS, params.get("return")),
        chat: pick(CHATS, params.get("chat")),
      });
    case "ai":
      return defined({page:"ai",context:pick(["archive","help","none"] as const,params.get("context")),question:params.get("question")?.slice(0,4000)||undefined});
    case "notes":
    case "map":
      return { page: head };
    default:
      return { page: "library" };
  }
}

export function formatRoute(route: Route): string {
  switch (route.page) {
    case "recording":
      return `#/recording/${encodeURIComponent(route.id)}${route.at != null ? `?t=${Math.round(route.at * 10) / 10}` : ""}`;
    case "tools": {
      const params=new URLSearchParams();if(route.tab)params.set("tab",route.tab);if(route.source)params.set("source",route.source);return "#/tools"+(params.size?"?"+params:"");
    }
    case "ai": {
      const params=new URLSearchParams();if(route.context)params.set("context",route.context);if(route.question)params.set("question",route.question);return "#/ai"+(params.size?`?${params}`:"");
    }
    case "search":
      return route.q ? `#/search?${new URLSearchParams({ q: route.q })}` : "#/search";
    case "speakers":
      return route.id ? `#/speakers/${encodeURIComponent(route.id)}` : "#/speakers";
    case "documents":
      return route.id ? `#/documents/${encodeURIComponent(route.id)}` : "#/documents";
    case "settings":
      return route.section ? `#/settings?section=${route.section}` : "#/settings";
    case "pipeline":
      return route.tab ? `#/pipeline?tab=${route.tab}` : "#/pipeline";
    case "setup": {
      const params = new URLSearchParams();
      if (route.step) params.set("step", route.step);
      if (route.returnTo) params.set("return", route.returnTo);
      if (route.chat) params.set("chat", route.chat);
      return "#/setup" + (params.size ? `?${params}` : "");
    }
    default:
      return `#/${route.page}`;
  }
}

export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const hash = formatRoute(next);
    if (options?.replace) {
      history.replaceState(null, "", hash);
      setRoute(next);
    } else if (location.hash !== hash) {
      location.hash = hash;
    }
  }, []);
  const back = useCallback(() => history.back(), []);
  return { route, navigate, back };
}
