import { useEffect, useState } from "react";
import { Download, Square } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clamp } from "./clamp.ts";
import { clockPrecise, exportName, parseClock, spanLabel } from "../lib/format.ts";
import { clampRange, type Range } from "../lib/range.ts";
import { useStoredState } from "../lib/storage.ts";
import type { MediaFormat, Recording, TextFormat } from "../lib/types.ts";
import { cx } from "../lib/cx.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";

type Format = MediaFormat | TextFormat;
type Choice = { value: Format; title: string; text: string; ext: string; video?: boolean };

const MEDIA: Choice[] = [
  { value: "m4a", title: "M4A audio", text: "AAC · small and widely supported", ext: "m4a" },
  { value: "mp3", title: "MP3 audio", text: "Plays anywhere", ext: "mp3" },
  { value: "mp4-accurate", title: "MP4 video · accurate", text: "Exact cut · re-encodes the picture", ext: "mp4", video: true },
  { value: "mp4-fast", title: "MP4 video · fast", text: "Quick · may start a few seconds early", ext: "mp4", video: true },
];
const TEXT: Choice[] = [
  { value: "txt", title: "Text", text: ".txt with times and speakers", ext: "txt" },
  { value: "md", title: "Markdown", text: ".md grouped by speaker", ext: "md" },
  { value: "srt", title: "Subtitles", text: ".srt timed to this range", ext: "srt" },
];
const ALL = [...MEDIA, ...TEXT];
const isFormat = (v: unknown) => ALL.some((c) => c.value === v);

function TimeField({ label, value, onCommit, onPlayhead }: { label: string; value: number; onCommit: (t: number) => void; onPlayhead: () => void }) {
  const [text, setText] = useState(clockPrecise(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setText(clockPrecise(value));
    setInvalid(false);
  }, [value]);
  const commit = () => {
    const t = parseClock(text);
    if (t == null) setInvalid(true);
    else onCommit(t);
  };
  return (
    <label className={cx("field time-field", invalid && "is-invalid")}>
      {label}
      <span className="time-field-row">
        <input
          className="mono"
          value={text}
          aria-invalid={invalid}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
        <Button size="sm" variant="ghost" onClick={onPlayhead}>
          Use playhead
        </Button>
      </span>
      {invalid && <span className="field-error">Use h:mm:ss, m:ss, or seconds</span>}
    </label>
  );
}

export function ExportDialog({
  open,
  onOpenChange,
  recording,
  range,
  onRange,
  mediaAvailable,
  playhead,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  recording: Recording;
  range: Range;
  onRange: (r: Range) => void;
  mediaAvailable: boolean;
  playhead: () => number;
}) {
  const toast = useToast();
  const media = recording.media;
  const [videoChoice, setVideoChoice] = useStoredState<Format>("export-format-video-v1", "mp4-accurate", isFormat);
  const [audioChoice, setAudioChoice] = useStoredState<Format>("export-format-audio-v1", "m4a", isFormat);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const stored = media.kind === "video" ? videoChoice : audioChoice;
  const choose = media.kind === "video" ? setVideoChoice : setAudioChoice;
  const unavailable = (c: Choice) => (c.video && media.kind !== "video" ? "This recording has no video" : !mediaAvailable && MEDIA.includes(c) ? "Media unavailable" : "");
  const current = ALL.find((c) => c.value === stored && !unavailable(c)) ?? (mediaAvailable ? MEDIA[0] : TEXT[0]);
  const isMedia = MEDIA.includes(current);
  const duration = media.duration;

  const run = async () => {
    const defaultPath = exportName(media.title, range.start, range.end, current.ext);
    const dest = await api.pickSavePath({ title: "Export range", name: current.title, extensions: [current.ext], defaultPath });
    if (!dest) return;
    setBusy(true);
    setProgress(0);
    const stop = isMedia ? await api.onExportProgress(setProgress) : () => {};
    try {
      const path = isMedia
        ? await api.exportMedia(media.id, range.start, range.end, current.value as MediaFormat, dest)
        : await api.exportTranscript(media.id, range.start, range.end, current.value as TextFormat, dest);
      toast.success(`Exported ${path.split("/").pop()}`, { label: "Show in folder", run: () => void api.reveal(path).catch(toast.error) });
      onOpenChange(false);
    } catch (e) {
      if (!String(e).toLowerCase().includes("cancelled")) toast.error(e);
    } finally {
      stop();
      setBusy(false);
    }
  };
  const cancel = () => void api.cancelExport().catch(toast.error);
  const card = (c: Choice) => {
    const reason = unavailable(c);
    return (
      <button
        key={c.value}
        type="button"
        role="radio"
        aria-checked={current.value === c.value}
        disabled={!!reason || busy}
        className={cx("choice-card", current.value === c.value && "is-on")}
        onClick={() => choose(c.value)}
      >
        <b>{c.title}</b>
        <span>{reason || c.text}</span>
      </button>
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) cancel();
        onOpenChange(next);
      }}
      title="Export range"
      description={`${media.title} · ${spanLabel(range.end - range.start)}`}
      size="lg"
      footer={
        busy ? (
          <Button variant="secondary" icon={Square} onClick={cancel}>
            Cancel export
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Download} onClick={() => void run()}>
              Export…
            </Button>
          </>
        )
      }
    >
      <div className="export-dialog">
        <div className="export-times">
          <TimeField
            label="Start"
            value={range.start}
            onCommit={(t) => onRange(clampRange({ start: t, end: Math.max(range.end, t + 0.5) }, duration))}
            onPlayhead={() => onRange(clampRange({ start: clamp(playhead(), 0, range.end - 0.5), end: range.end }, duration))}
          />
          <TimeField
            label="End"
            value={range.end}
            onCommit={(t) => onRange(clampRange({ start: Math.min(range.start, t - 0.5), end: t }, duration))}
            onPlayhead={() => onRange(clampRange({ start: range.start, end: Math.max(playhead(), range.start + 0.5) }, duration))}
          />
        </div>
        <section>
          <h4 className="menu-label">Media</h4>
          <div className="choice-grid" role="radiogroup" aria-label="Media format">
            {MEDIA.map(card)}
          </div>
        </section>
        <section>
          <h4 className="menu-label">Transcript</h4>
          <div className="choice-grid is-three" role="radiogroup" aria-label="Transcript format">
            {TEXT.map(card)}
          </div>
        </section>
        {busy && (
          <div className="export-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <span className="export-progress-track">
              <span style={{ width: `${Math.round(progress * 100)}%` }} />
            </span>
            <span className="num">{isMedia ? `${Math.round(progress * 100)}%` : "Writing…"}</span>
          </div>
        )}
      </div>
    </Dialog>
  );
}
