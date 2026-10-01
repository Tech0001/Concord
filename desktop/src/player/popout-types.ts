import type { Media } from "../lib/types.ts";

export type PlaybackPosition = {
  seconds: number;
  duration: number;
  playing: boolean;
  rate: number;
  volume: number;
  muted: boolean;
  ready: boolean;
  error: string;
};
export type PopoutSession = {
  token: string;
  media: Media;
  source: string;
  skipGaps: boolean;
  position: PlaybackPosition;
};
export type PopoutCommand =
  | { kind: "play" | "pause" | "toggle" | "mute" }
  | { kind: "seek"; seconds: number; play: boolean }
  | { kind: "rate" | "volume"; value: number }
  | { kind: "gaps"; value: boolean };
