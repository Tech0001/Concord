import { createContext, useContext } from "react";
import type { Route } from "../lib/router.ts";
import type { Category, Job, Note, Overview } from "../lib/types.ts";
import type { SetupStatus } from "../setup/types.ts";

export type AppContextValue = {
  category: Category;
  setCategory: (category: Category) => void;
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
  openAsk: (intent?: Partial<import("../ai/ChatStore.tsx").AskIntent>) => void;
  addRecordings: () => Promise<void>;
  /** Resolves true when a library was imported. */
  importLegacy: (path?: string) => Promise<boolean>;
  /** Readiness for setup, the Library checklist and the sidebar; polled while downloads run. */
  setup?: SetupStatus;
  refreshSetup: () => Promise<void>;
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
