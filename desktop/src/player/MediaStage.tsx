import { useEffect, useState, type Ref } from "react";
import { AudioLines, CircleAlert, Play } from "lucide-react";
import type { Media } from "../lib/types.ts";
import type { MediaControls } from "./useMedia.ts";

/** The video element, or a compact cover with a hidden audio element. Missing media shows a quiet notice. */
export function MediaStage({
  media,
  source,
  sourceError,
  controls,
  mediaRef,
}: {
  media: Media;
  source: string;
  sourceError: string;
  controls: MediaControls;
  mediaRef: Ref<HTMLMediaElement>;
}) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const problem = sourceError || controls.error;
  if (problem)
    return (
      <div className="media-stage is-missing" role="status">
        <CircleAlert size={22} aria-hidden />
        <p>{problem}</p>
        <p className="muted">The transcript is still available.</p>
      </div>
    );
  if (media.kind === "audio")
    return (
      <div className="media-stage is-audio">
        <audio ref={mediaRef as Ref<HTMLAudioElement>} src={source || undefined} preload="metadata" />
        <span className="audio-glyph" aria-hidden>
          <AudioLines size={26} />
        </span>
        <span className="audio-copy">
          <b>{media.channel}</b>
          <small>Audio recording</small>
        </span>
      </div>
    );
  return (
    <div className="media-stage is-video">
      <video
        ref={mediaRef as Ref<HTMLVideoElement>}
        src={source || undefined}
        preload="metadata"
        playsInline
        controls={fullscreen}
        onClick={() => controls.toggle()}
        onDoubleClick={(e) => {
          const el = e.currentTarget;
          if (document.fullscreenElement) void document.exitFullscreen();
          else void el.requestFullscreen?.();
        }}
      />
      {!controls.playing && source && (
        <button type="button" className="video-play" aria-label="Play" onClick={() => controls.play()}>
          <Play size={22} fill="currentColor" />
        </button>
      )}
    </div>
  );
}
