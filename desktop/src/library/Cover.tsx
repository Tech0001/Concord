import { useEffect, useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { humanDuration } from "../lib/format.ts";
import { cx } from "../lib/cx.ts";
import type { Media } from "../lib/types.ts";

/** Lazily loaded thumbnail with duration and resume progress. Audio recordings get a quiet cover. */
export function Cover({ media, compact = false }: { media: Media; compact?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  useEffect(() => {
    if (media.kind === "audio") return;
    let alive = true;
    setSource(null);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        api
          .thumbnail(media.id)
          .then((url) => alive && url && setSource(url))
          .catch(() => {
            /* A missing thumbnail keeps the plain cover; nothing to report. */
          });
      },
      { rootMargin: "300px" },
    );
    if (element.current) observer.observe(element.current);
    return () => {
      alive = false;
      observer.disconnect();
    };
  }, [media.id, media.kind]);
  const progress = media.duration > 0 && media.position > 5 ? Math.min(1, media.position / media.duration) : 0;
  return (
    <div ref={element} className={cx("cover", media.kind === "audio" && "is-audio", compact && "is-compact")}>
      {source ? (
        <img src={source} alt="" loading="lazy" onError={() => setSource(null)} />
      ) : (
        <span className="cover-glyph" aria-hidden>
          <AudioLines size={compact ? 18 : 30} strokeWidth={1.5} />
        </span>
      )}
      {!compact && media.duration > 0 && <span className="cover-duration num">{humanDuration(media.duration)}</span>}
      {progress > 0 && <span className="cover-progress" style={{ width: `${progress * 100}%` }} aria-hidden />}
    </div>
  );
}
