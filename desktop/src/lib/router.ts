import { useCallback, useEffect, useState } from "react";

export type Route =
  | { page: "library" }
  | { page: "recording"; id: string; at?: number }
  | { page: "search"; q: string }
  | { page: "documents"; id?: string }
  | { page: "speakers"; id?: string }
  | { page: "notes" }
  | { page: "map" }
  | { page: "pipeline" }
  | { page: "ai" }
  | { page: "settings" };
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
    case "search":
      return { page: "search", q: params.get("q") ?? "" };
    case "documents":
      return tail ? { page: "documents", id: decodeURIComponent(tail) } : { page: "documents" };
    case "speakers":
      return tail ? { page: "speakers", id: decodeURIComponent(tail) } : { page: "speakers" };
    case "notes":
    case "map":
    case "pipeline":
    case "ai":
    case "settings":
      return { page: head };
    default:
      return { page: "library" };
  }
}

export function formatRoute(route: Route): string {
  switch (route.page) {
    case "recording":
      return `#/recording/${encodeURIComponent(route.id)}${route.at != null ? `?t=${Math.round(route.at * 10) / 10}` : ""}`;
    case "search":
      return route.q ? `#/search?${new URLSearchParams({ q: route.q })}` : "#/search";
    case "speakers":
      return route.id ? `#/speakers/${encodeURIComponent(route.id)}` : "#/speakers";
    case "documents":
      return route.id ? `#/documents/${encodeURIComponent(route.id)}` : "#/documents";
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
