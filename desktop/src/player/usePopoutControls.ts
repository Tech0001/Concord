import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/ipc.ts";
import type { TimeStore } from "../lib/timeStore.ts";
import { useToast } from "../ui/Toasts.tsx";
import { usePopout } from "./PopoutContext.tsx";
import type { PopoutCommand } from "./popout-types.ts";
import type { MediaControls } from "./useMedia.ts";

export function usePopoutControls(
  id: string,
  local: MediaControls,
  el: HTMLMediaElement | null,
  time: TimeStore,
  skipGaps: boolean,
) {
  const popout = usePopout();
  const toast = useToast();
  const current = popout.session?.media.id === id ? popout.session : null;
  const [opening, setOpening] = useState(false);
  const returned = useRef(popout.closed?.token);
  const localRef = useRef(local);
  localRef.current = local;
  useEffect(() => {
    if (!current) return;
    el?.pause();
    time.set(popout.time.get());
    return popout.time.subscribe(() => time.set(popout.time.get()));
  }, [current?.token, el, time, popout.time]);
  useEffect(() => {
    const closed = popout.closed;
    if (
      !closed ||
      closed.token === returned.current ||
      closed.media.id !== id ||
      !local.ready
    )
      return;
    returned.current = closed.token;
    const p = closed.position;
    local.setRate(p.rate);
    local.setVolume(p.volume);
    if (el && el.muted !== p.muted) local.toggleMute();
    local.seek(p.seconds, p.playing);
  }, [popout.closed, local, el, id]);
  const run = useCallback(
    (command: PopoutCommand) => {
      if (current)
        void api.popoutCommand(current.token, command).catch(toast.error);
    },
    [current?.token, toast],
  );
  const playLocal = useCallback(() => {
    void popout
      .pauseOther(id)
      .then(() => localRef.current.play())
      .catch(toast.error);
  }, [id, popout.pauseOther, toast]);
  const controls = useMemo<MediaControls>(
    () =>
      current
        ? {
            ...current.position,
            play: () => run({ kind: "play" }),
            pause: () => run({ kind: "pause" }),
            toggle: () => run({ kind: "toggle" }),
            seek: (seconds, play = false) =>
              run({ kind: "seek", seconds: Math.max(0, seconds), play }),
            skip: (delta) =>
              run({
                kind: "seek",
                seconds: Math.max(0, popout.time.get() + delta),
                play: false,
              }),
            setRate: (value) => run({ kind: "rate", value }),
            setVolume: (value) => run({ kind: "volume", value }),
            toggleMute: () => run({ kind: "mute" }),
          }
        : {
            ...local,
            play: playLocal,
            toggle: () => (local.playing ? local.pause() : playLocal()),
            seek: (seconds, play = false) => {
              local.seek(seconds);
              if (play) playLocal();
            },
          },
    [current, local, run, playLocal, popout.time],
  );
  const setGaps = useCallback((value: boolean) => run({ kind: "gaps", value }), [run]);
  const open = async () => {
    const wasPlaying = el ? !el.paused : local.playing;
    setOpening(true);
    local.pause();
    try {
      await popout.open(id, {
        seconds: el?.currentTime ?? time.get(),
        duration: local.duration,
        playing: wasPlaying,
        rate: el?.playbackRate ?? local.rate,
        volume: el?.volume ?? local.volume,
        muted: el?.muted ?? local.muted,
        ready: false,
        error: "",
      }, skipGaps);
    } catch (e) {
      toast.error(e);
      if (wasPlaying) local.play();
    } finally {
      setOpening(false);
    }
  };
  return { controls, active: !!current, opening, open, setGaps };
}
