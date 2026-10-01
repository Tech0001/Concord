import { speechIntervals, nextAfterGap, type SpeechInterval } from "./gaps.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import { PictureInPicture2 } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { createTimeStore, useTime } from "../lib/timeStore.ts";
import { useShortcuts } from "../lib/shortcuts.ts";
import { Button } from "../ui/Button.tsx";
import { ToastProvider, useToast } from "../ui/Toasts.tsx";
import { MediaStage } from "./MediaStage.tsx";
import { Transport } from "./Transport.tsx";
import { useMedia } from "./useMedia.ts";
import type { PopoutSession } from "./popout-types.ts";
import "./player.css";

export default function PopoutPage() {
  return (
    <ToastProvider>
      <Player />
    </ToastProvider>
  );
}
function Player() {
  const [session, setSession] = useState<PopoutSession | null>(null);
  const [skipGaps, setSkipGaps] = useState(false);
  const [intervals, setIntervals] = useState<SpeechInterval[]>([]);
  const [el, setElement] = useState<HTMLMediaElement | null>(null);
  const toast = useToast();
  const time = useMemo(() => createTimeStore(), []);
  const controls = useMedia(
    el,
    time,
    session?.position.duration ?? 0,
    session?.source ?? "",
  );
  const latest = useRef(controls);
  latest.current = controls;
  const started = useRef("");
  const initialized = useRef(false);
  const elRef = useRef(el);
  elRef.current = el;
  const finishing = useRef(false);
  const snapshot = () => {
    const c = latest.current,
      media = elRef.current;
    return {
      seconds: media?.currentTime ?? time.get(),
      duration: c.duration,
      playing: media ? !media.paused : c.playing,
      rate: media?.playbackRate ?? c.rate,
      volume: media?.volume ?? c.volume,
      muted: media?.muted ?? c.muted,
      ready: c.ready,
      error: c.error,
    };
  };
  const finish = async (resume: boolean) => {
    if (!session || finishing.current) return;
    finishing.current = true;
    try {
      await api.popoutUpdate(session.token, snapshot());
      await api.popoutClose(resume);
    } catch (e) {
      finishing.current = false;
      toast.error(e);
    }
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const t = useTime(time, (n) => Math.round(n * 4) / 4);
  useEffect(() => {
    void api.popoutState().then(value => { setSession(value); setSkipGaps(value?.skipGaps ?? false); }).catch(toast.error);
  }, [toast]);
  useEffect(() => {
    let alive = true;
    if (session) void api.recording(session.media.id).then(recording => { if (alive) setIntervals(speechIntervals(recording.segments)); }).catch(toast.error);
    return () => { alive = false; };
  }, [session?.token, toast]);
  useEffect(() => {
    if (!skipGaps || !controls.playing || !intervals.length) return;
    const check = () => {
      const target = nextAfterGap(intervals, time.get());
      if (target !== null) controls.seek(target);
    };
    check(); return time.subscribe(check);
  }, [skipGaps, controls, intervals, time]);
  useEffect(() => {
    if (!session || !controls.ready || started.current === session.token)
      return;
    started.current = session.token;
    const p = session.position;
    controls.setRate(p.rate);
    controls.setVolume(p.volume);
    if (el && el.muted !== p.muted) controls.toggleMute();
    controls.seek(p.seconds, p.playing);
    initialized.current = true;
  }, [session, controls, el]);
  useEffect(() => {
    if (!session) return;
    let alive = true,
      remove = () => {};
    void api
      .onPopoutCommand(({ token, command }) => {
        if (!alive || token !== session.token) return;
        const c = latest.current;
        switch (command.kind) {
          case "play":
            c.play();
            break;
          case "pause":
            c.pause();
            break;
          case "toggle":
            c.toggle();
            break;
          case "seek":
            c.seek(command.seconds, command.play);
            break;
          case "rate":
            c.setRate(command.value);
            break;
          case "volume":
            c.setVolume(command.value);
            break;
          case "gaps": setSkipGaps(command.value); break;
        case "mute":
            c.toggleMute();
            break;
        }
      })
      .then((fn) => {
        if (alive) remove = fn;
        else fn();
      })
      .catch(toast.error);
    return () => {
      alive = false;
      remove();
    };
  }, [session?.token, toast]);
  useEffect(() => {
    if (!session) return;
    let alive = true,
      remove = () => {};
    void api
      .onPopoutReturn(({ token, resume }) => {
        if (alive && token === session.token) void finishRef.current(resume);
      })
      .then((fn) => {
        if (alive) remove = fn;
        else fn();
      })
      .catch(toast.error);
    return () => {
      alive = false;
      remove();
    };
  }, [session?.token, toast]);
  useEffect(() => {
    if (!session) return;
    let pending = false,
      alive = true,
      failed = false;
    const publish = async () => {
      if (
        pending ||
        finishing.current ||
        !alive ||
        (!initialized.current && !latest.current.error)
      )
        return;
      pending = true;
      try {
        await api.popoutUpdate(session.token, snapshot());
      } catch (e) {
        if (!failed && alive) {
          failed = true;
          toast.error(e);
        }
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void publish(), 250);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session?.token, time, toast]);
  useShortcuts([
    { key: " ", run: () => controls.toggle() },
    { key: "ArrowLeft", run: () => controls.skip(-10) },
    { key: "ArrowRight", run: () => controls.skip(10) },
    { key: "m", run: () => controls.toggleMute() },
    {
      key: "f",
      run: () => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void el?.requestFullscreen();
      },
    },
  ]);
  if (!session) return <p className="muted">Opening video…</p>;
  return (
    <main className="popout-player">
      <header>
        <strong>{session.media.title}</strong>
        <Button
          size="sm"
          icon={PictureInPicture2}
          onClick={() => void finish(true)}
        >
          Return to Concord
        </Button>
      </header>
      <MediaStage
        media={session.media}
        source={session.source}
        sourceError=""
        controls={controls}
        mediaRef={setElement}
      />
      <input
        className="popout-seek"
        type="range"
        min={0}
        max={controls.duration || 1}
        step={0.1}
        value={t}
        aria-label="Video position"
        onChange={(e) => controls.seek(Number(e.target.value))}
      />
      <Transport controls={controls} time={time} />
    </main>
  );
}
