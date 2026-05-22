import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * Sidebar collapse state — persisted to localStorage so the choice
 * sticks across reloads. Two states only for v1: full (200px) vs
 * rail (icons-only, ~48px). A future polish could add a "hidden"
 * state for max-focus reading.
 */
type SidebarState = "expanded" | "collapsed";

const STORAGE_KEY = "concord-sidebar-v1";

function readStored(): SidebarState {
  if (typeof window === "undefined") return "expanded";
  return window.localStorage.getItem(STORAGE_KEY) === "collapsed" ? "collapsed" : "expanded";
}

interface SidebarContextValue {
  state: SidebarState;
  collapsed: boolean;
  toggle: () => void;
  set: (state: SidebarState) => void;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SidebarState>(readStored);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, state);
  }, [state]);

  const toggle = useCallback(() => {
    setState((s) => (s === "expanded" ? "collapsed" : "expanded"));
  }, []);

  const value = useMemo<SidebarContextValue>(() => ({
    state,
    collapsed: state === "collapsed",
    toggle,
    set: setState,
  }), [state, toggle]);

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used inside SidebarProvider");
  return ctx;
}
