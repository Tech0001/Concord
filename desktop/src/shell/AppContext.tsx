import { createContext, useContext } from "react";
import type { Route } from "../lib/router.ts";
import type { Job, Note, Overview } from "../lib/types.ts";

export type AppContextValue = {
  route: Route;
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  back: () => void;
  overview?: Overview;
  revision: number;
  refresh: () => void;
  jobs: Job[];
  activeJob?: Job;
  device: string;
  setDevice: (device: string) => void;
  transcribe: (id: string) => Promise<void>;
  openNote: (note: Note) => void;
  openPalette: () => void;
  openActivity: () => void;
  addRecordings: () => Promise<void>;
  importLegacy: (path?: string) => Promise<void>;
  /** Title shown in the top bar; pages like the player set it and clear it (null) on unmount. */
  pageTitle: string | null;
  setPageTitle: (title: string | null) => void;
};

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside the app shell");
  return value;
}
