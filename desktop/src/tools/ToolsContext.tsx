import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Mic, AudioLines } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock } from "../lib/format.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import type { ToolsState } from "./types.ts";
import "./tools.css";

const Context = createContext<{
  state?: ToolsState;
  error: string;
  reload: () => Promise<void>;
}>({ error: "", reload: async () => {} });
export const useTools = () => useContext(Context);
export function ToolsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ToolsState>();
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setState(await api.toolsState());
    setError("");
  }, []);
  useEffect(() => {
    if (!api.available()) return;
    let alive = true,
      timer = 0;
    const poll = async () => {
      let delay = 2000;
      try {
        const next = await api.toolsState();
        if (!alive) return;
        setState(next);
        setError("");
        delay = next.recorder.active || next.extract.running || next.liveTranscript?.running ? 300 : 2000;
      } catch (e) {
        if (alive) setError(String(e));
      }
      if (alive) timer = window.setTimeout(poll, delay);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  return (
    <Context.Provider value={{ state, error, reload }}>
      {children}
    </Context.Provider>
  );
}
export function ToolIndicator() {
  const { state } = useTools();
  const { navigate } = useApp();
  const voice = state?.recorder.active;
  if (voice)
    return (
      <Button
        className="recording-indicator"
        size="sm"
        icon={Mic}
        onClick={() => navigate({ page: "tools", tab: "record" })}
      >
        Recording {clock(voice.seconds)}
      </Button>
    );
  if (state?.liveTranscript?.running)
    return <Button size="sm" icon={AudioLines} onClick={() => navigate({page:"tools",tab:"record"})}>Voice transcript preview</Button>;
  if (state?.extract.running)
    return (
      <Button
        size="sm"
        icon={AudioLines}
        onClick={() => navigate({ page: "tools", tab: "extract" })}
      >
        Extracting {Math.round(state.extract.progress * 100)}%
      </Button>
    );
  if (state?.recorder.sessions.length)
    return (
      <Button
        size="sm"
        icon={Mic}
        onClick={() => navigate({ page: "tools", tab: "record" })}
      >
        Unsaved voice notes ({state.recorder.sessions.length})
      </Button>
    );
  return null;
}
