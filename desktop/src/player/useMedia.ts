import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimeStore } from "../lib/timeStore.ts";
import { useStoredState } from "../lib/storage.ts";

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];

export type MediaControls = {
  playing: boolean;
  duration: number;
  rate: number;
  volume: number;
  muted: boolean;
  ready: boolean;
  error: string;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number, andPlay?: boolean): void;
  skip(delta: number): void;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  toggleMute(): void;
};

/** Drives an audio or video element; playback time flows into the time store, not React state. */
export function useMedia(el: HTMLMediaElement | null, time: TimeStore, fallbackDuration: number, src: string): MediaControls {
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(fallbackDuration);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [muted, setMuted] = useState(false);
  const [rate, setRateStored] = useStoredState("player-rate-v1", 1, (v) => RATES.includes(v as number));
  const [volume, setVolumeStored] = useStoredState("player-volume-v1", 1, (v) => typeof v === "number" && v >= 0 && v <= 1);
  const prefs = useRef({ rate, volume });
  prefs.current = { rate, volume };

  useEffect(() => setDuration((d) => d || fallbackDuration), [fallbackDuration]);

  useEffect(() => {
    if (!el || !src) return;
    setPlaying(false);
    setReady(false);
    setError("");
    let frame = 0;
    let lastTick = 0;
    const tick = (now: number) => {
      if (now - lastTick >= 50) {
        lastTick = now;
        time.set(el.currentTime);
      }
      frame = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      setPlaying(true);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(tick);
    };
    const onPause = () => {
      setPlaying(false);
      cancelAnimationFrame(frame);
      time.set(el.currentTime);
    };
    const onSeeked = () => time.set(el.currentTime);
    const onVolume = () => setMuted(el.muted);
    const onMeta = () => {
      if (Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
      el.playbackRate = prefs.current.rate;
      el.volume = prefs.current.volume;
      setReady(true);
    };
    const onError = () => setError("This media could not be played on this system.");
    const events: [string, () => void][] = [
      ["play", onPlay],
      ["pause", onPause],
      ["ended", onPause],
      ["seeked", onSeeked],
      ["timeupdate", onSeeked],
      ["volumechange", onVolume],
      ["loadedmetadata", onMeta],
      ["error", onError],
    ];
    events.forEach(([name, fn]) => el.addEventListener(name, fn));
    if (el.readyState >= 1) onMeta();
    if (!el.paused) onPlay();
    return () => {
      cancelAnimationFrame(frame);
      events.forEach(([name, fn]) => el.removeEventListener(name, fn));
    };
  }, [el, time, src]);

  const play = useCallback(() => {
    el?.play().catch((e: unknown) => {
      // A newer seek or pause interrupting play() is expected, not an error.
      if ((e as DOMException)?.name !== "AbortError") setError(e instanceof Error ? e.message : String(e));
    });
  }, [el]);
  const pause = useCallback(() => el?.pause(), [el]);
  const seek = useCallback(
    (t: number, andPlay = false) => {
      if (!el) return;
      const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : duration || t;
      el.currentTime = Math.min(Math.max(0, t), max);
      time.set(el.currentTime);
      if (andPlay) play();
    },
    [el, time, duration, play],
  );
  return useMemo(
    () => ({
      playing,
      duration,
      rate,
      volume,
      muted,
      ready,
      error,
      play,
      pause,
      seek,
      toggle: () => (el?.paused ? play() : pause()),
      skip: (delta: number) => seek(time.get() + delta),
      setRate: (r: number) => {
        setRateStored(r);
        if (el) el.playbackRate = r;
      },
      setVolume: (v: number) => {
        setVolumeStored(v);
        if (el) {
          el.volume = v;
          if (v > 0 && el.muted) {
            el.muted = false;
            setMuted(false);
          }
        }
      },
      toggleMute: () => {
        if (!el) return;
        el.muted = !el.muted;
        setMuted(el.muted);
      },
    }),
    [playing, duration, rate, volume, muted, ready, error, play, pause, seek, el, time, setRateStored, setVolumeStored],
  );
}
