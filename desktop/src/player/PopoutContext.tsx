import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { PictureInPicture2 } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { createTimeStore, type TimeStore } from "../lib/timeStore.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import type { PlaybackPosition, PopoutSession } from "./popout-types.ts";

const Context = createContext<{
  session: PopoutSession | null;
  closed: PopoutSession | null;
  time: TimeStore;
  open: (id: string, position: PlaybackPosition, skipGaps: boolean) => Promise<void>;
  pauseOther: (id: string) => Promise<void>;
}>(null!);
export const usePopout = () => useContext(Context);

export function PopoutProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PopoutSession | null>(null);
  const [closed, setClosed] = useState<PopoutSession | null>(null);
  const latest = useRef<PopoutSession | null>(null);
  const time = useMemo(() => createTimeStore(), []);
  const toast = useToast();
  const apply = useCallback(
    (next: PopoutSession | null) => {
      latest.current = next;
      if (next) time.set(next.position.seconds);
      // Time has its own subscription. Do not rerender every transcript row on a clock tick.
      setSession((old) => {
        if (
          old &&
          next &&
          old.token === next.token &&
          JSON.stringify({ ...old.position, seconds: 0 }) ===
            JSON.stringify({ ...next.position, seconds: 0 })
        )
          return old;
        return next;
      });
    },
    [time],
  );
  useEffect(() => {
    let alive = true;
    const unsub: (() => void)[] = [];
    const attach = (fn: () => void) => {
      if (alive) unsub.push(fn);
      else fn();
    };
    void (async () => {
      attach(await api.onPopoutState((next) => alive && apply(next)));
      attach(
        await api.onPopoutClosed((next) => {
          if (alive) {
            apply(null);
            setClosed(next);
          }
        }),
      );
      const current = await api.popoutState();
      if (alive) apply(current);
    })().catch(toast.error);
    return () => {
      alive = false;
      unsub.forEach((fn) => fn());
    };
  }, [apply, toast]);
  const open = useCallback(
    async (id: string, position: PlaybackPosition, skipGaps: boolean) => {
      setClosed(null);
      apply(await api.popoutOpen(id, position, skipGaps));
    },
    [apply],
  );
  const pauseOther = useCallback(async (id: string) => {
    const current = latest.current;
    if (!current || current.media.id === id || !current.position.playing)
      return;
    await api.popoutCommand(current.token, { kind: "pause" });
    for (let n = 0; n < 30; n++) {
      const next = await api.popoutState();
      if (!next || !next.position.playing) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error(
      "The pop-out video did not pause. Close it before starting another recording.",
    );
  }, []);
  return (
    <Context.Provider value={{ session, closed, time, open, pauseOther }}>
      {children}
    </Context.Provider>
  );
}

export function PopoutIndicator() {
  const { session } = usePopout();
  const { navigate } = useApp();
  if (!session) return null;
  return (
    <Button
      size="sm"
      icon={PictureInPicture2}
      title={session.media.title}
      onClick={() => navigate({ page: "recording", id: session.media.id })}
    >
      Pop-out video
    </Button>
  );
}
