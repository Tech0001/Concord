import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AlertCircle, Circle, CircleCheck, CircleDot, Copy, FolderOpen, Keyboard, LoaderCircle } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { copyText } from "../lib/clipboard.ts";
import { indexAt, speakerTurns, type Range } from "../lib/range.ts";
import { createTimeStore, type TimeStore } from "../lib/timeStore.ts";
import { useShortcuts } from "../lib/shortcuts.ts";
import { TABLET, useMediaQuery } from "../lib/media-query.ts";
import { speakerColor } from "../lib/speakers.ts";
import type { Recording, ReviewState } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import type { MenuEntry } from "../ui/Menu.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { errorMessage, useToast } from "../ui/Toasts.tsx";
import { REVIEW_LABELS } from "../library/recordingMenu.ts";
import { useApp } from "../shell/AppContext.tsx";
import { MediaStage } from "./MediaStage.tsx";
import { NameVoiceDialog } from "./NameVoiceDialog.tsx";
import { PlayerHeader } from "./PlayerHeader.tsx";
import { ShortcutSheet } from "./ShortcutSheet.tsx";
import { SpeakerPanel } from "./SpeakerPanel.tsx";
import { SplitLayout } from "./SplitLayout.tsx";
import { Timeline, type LaneTurn } from "./Timeline.tsx";
import { Transcript } from "./Transcript.tsx";
import { Transport } from "./Transport.tsx";
import { RATES, useMedia } from "./useMedia.ts";
import { buildVoices, type Voice } from "./voices.ts";
import "./player.css";

/** Saves the playback position every 10 s of movement, on pause, and when leaving. One failure toast per recording. */
function usePositionSaver(id: string, time: TimeStore, playing: boolean, ready: boolean, onFail: (e: unknown) => void) {
  const last = useRef<number | null>(null);
  const failed = useRef(false);
  const save = useCallback(
    (force = false) => {
      const t = time.get();
      if (!force && last.current !== null && Math.abs(t - last.current) < 1) return;
      last.current = t;
      api.savePosition(id, t).catch((e) => {
        if (!failed.current) {
          failed.current = true;
          onFail(e);
        }
      });
    },
    [id, time, onFail],
  );
  useEffect(() => {
    last.current = null;
    failed.current = false;
  }, [id]);
  useEffect(() => time.subscribe(() => last.current !== null && Math.abs(time.get() - last.current) >= 10 && save()), [time, save]);
  useEffect(() => {
    if (ready && !playing) save(last.current === null);
  }, [ready, playing, save]);
  useEffect(() => () => save(), [save]);
}

export function PlayerPage({ id, at }: { id: string; at?: number }) {
  const { revision, refresh, setPageTitle, navigate } = useApp();
  const toast = useToast();
  const stacked = useMediaQuery(TABLET);
  const [data, setData] = useState<Recording>();
  const [loadError, setLoadError] = useState("");
  const [starred, setStarred] = useState(false);
  const [review, setReview] = useState<ReviewState>("unreviewed");
  const [source, setSource] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [range, setRange] = useState<Range | null>(null);
  const [naming, setNaming] = useState<Voice | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pane, setPane] = useState<"transcript" | "speakers">("transcript");
  const mediaRef = useRef<HTMLMediaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  // One time store per recording, so listeners never leak across recordings.
  const time = useMemo(() => createTimeStore(at ?? 0), [id]);

  useEffect(() => {
    let alive = true;
    api
      .recording(id)
      .then((r) => {
        if (!alive) return;
        setData(r);
        setStarred(!!r.media.starred);
        setReview(r.media.review_state);
      })
      .catch((e) => alive && setLoadError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [id, revision]);
  useEffect(() => {
    let alive = true;
    setSource("");
    setSourceError("");
    api
      .mediaUrl(id)
      .then((url) => alive && setSource(url))
      .catch((e) => alive && setSourceError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [id]);
  const kind = data?.media.kind;
  useEffect(() => {
    if (kind !== "audio") {
      setPeaks(null);
      return;
    }
    let alive = true;
    api
      .waveform(id)
      .then((p) => alive && setPeaks(p))
      .catch(() => alive && setPeaks(null)); // The timeline works without a waveform.
    return () => {
      alive = false;
    };
  }, [id, kind]);
  useEffect(() => {
    if (!data) return;
    setPageTitle(data.media.title);
    return () => setPageTitle(null);
  }, [data, setPageTitle]);

  const controls = useMedia(mediaRef, time, data?.media.duration ?? 0, source);
  const started = useRef("");
  useEffect(() => {
    if (!controls.ready || !data || started.current === id) return;
    started.current = id;
    const position = at ?? (data.media.position > 5 ? data.media.position : 0);
    if (position) controls.seek(position);
  }, [controls, data, id, at]);
  const onSaveFail = useCallback((e: unknown) => toast.error(`Couldn't save your place in this recording: ${errorMessage(e)}`), [toast]);
  usePositionSaver(id, time, controls.playing, controls.ready, onSaveFail);

  const lines = useMemo(() => data?.segments ?? [], [data]);
  const voices = useMemo(() => (data ? buildVoices(data.assignments, data.segments) : new Map<string, Voice>()), [data]);
  const turns = useMemo<LaneTurn[]>(
    () =>
      speakerTurns(lines).map((t) => ({
        ...t,
        color: voices.get(t.speaker)?.color ?? speakerColor(null, t.speaker),
        label: voices.get(t.speaker)?.name ?? t.speaker,
      })),
    [lines, voices],
  );

  const seekLine = useCallback(
    (index: number, play: boolean) => {
      const line = lines[index];
      if (!line) return;
      controls.seek(line.start, play);
      setFollow(true);
    },
    [lines, controls],
  );
  const onLine = useCallback((index: number, _e: MouseEvent) => seekLine(index, true), [seekLine]);
  const onVoice = useCallback((local: string) => setNaming(voices.get(local) ?? null), [voices]);
  const firstLine = (voice: Voice) => {
    const index = lines.findIndex((l) => l.speaker === voice.local);
    if (index >= 0) seekLine(index, false);
    if (stacked) setPane("transcript");
  };
  const longestLine = (voice: Voice) => {
    let best = -1;
    lines.forEach((l, i) => {
      if (l.speaker === voice.local && (best < 0 || l.end - l.start > lines[best].end - lines[best].start)) best = i;
    });
    if (best >= 0) seekLine(best, true);
  };
  const stepLine = (delta: number) => {
    if (!lines.length) return;
    const i = Math.min(lines.length - 1, Math.max(0, indexAt(lines, time.get()) + delta));
    seekLine(i, false);
  };
  const toggleFullscreen = () => {
    const el = mediaRef.current;
    if (!el || kind !== "video") return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };
  const stepRate = (delta: number) => {
    const i = RATES.indexOf(controls.rate);
    controls.setRate(RATES[Math.min(RATES.length - 1, Math.max(0, (i < 0 ? 1 : i) + delta))]);
  };
  useShortcuts(
    [
      { key: " ", run: () => controls.toggle() },
      { key: "k", run: () => controls.toggle() },
      { key: "ArrowLeft", shift: false, run: () => controls.skip(-10) },
      { key: "ArrowRight", shift: false, run: () => controls.skip(10) },
      { key: "ArrowLeft", shift: true, run: () => controls.skip(-60) },
      { key: "ArrowRight", shift: true, run: () => controls.skip(60) },
      { key: "ArrowUp", run: () => stepLine(-1) },
      { key: "ArrowDown", run: () => stepLine(1) },
      { key: "<", run: () => stepRate(-1) },
      { key: ">", run: () => stepRate(1) },
      { key: "m", run: () => controls.toggleMute() },
      { key: "f", run: toggleFullscreen },
      { key: "?", run: () => setShortcutsOpen(true) },
    ],
    !!data,
  );

  if (loadError)
    return (
      <Empty
        icon={AlertCircle}
        title="This recording could not be opened"
        text={loadError}
        action={<Button onClick={() => navigate({ page: "library" })}>Back to Library</Button>}
      />
    );
  if (!data)
    return (
      <div className="player-loading" role="status">
        <LoaderCircle className="spin" size={20} aria-hidden /> Loading recording…
      </div>
    );

  const media = data.media;
  const star = async () => {
    setStarred(!starred);
    try {
      await api.setStarred(media.id, !starred);
    } catch (e) {
      setStarred(starred);
      toast.error(e);
    }
  };
  const setReviewState = async (state: ReviewState) => {
    const before = review;
    setReview(state);
    try {
      await api.setReview(media.id, state);
    } catch (e) {
      setReview(before);
      toast.error(e);
    }
  };
  const menu: MenuEntry[] = [
    { kind: "label", label: "Review" },
    ...(Object.keys(REVIEW_LABELS) as ReviewState[]).map((s) => ({
      label: REVIEW_LABELS[s],
      icon: { unreviewed: Circle, in_review: CircleDot, reviewed: CircleCheck }[s],
      checked: review === s,
      onSelect: () => void setReviewState(s),
    })),
    { kind: "separator" },
    { label: "Show file in folder", icon: FolderOpen, disabled: !media.path, onSelect: () => media.path && api.reveal(media.path).catch(toast.error) },
    {
      label: "Copy file path",
      icon: Copy,
      disabled: !media.path,
      onSelect: () =>
        media.path &&
        copyText(media.path)
          .then(() => toast.success("File path copied"))
          .catch(toast.error),
    },
    { label: "Keyboard shortcuts", icon: Keyboard, hint: "?", onSelect: () => setShortcutsOpen(true) },
  ];
  const speakerPanel = <SpeakerPanel voices={voices} onName={setNaming} onFirstLine={firstLine} />;
  const transcript = (
    <Transcript
      lines={lines}
      voices={voices}
      time={time}
      follow={follow}
      setFollow={setFollow}
      onLine={onLine}
      onVoice={onVoice}
      scroller={scroller}
      stacked={stacked}
    />
  );
  return (
    <div className="player">
      <PlayerHeader recording={data} starred={starred} onStar={() => void star()} menu={menu} />
      <SplitLayout>
        <section className="player-media" aria-label="Playback">
          <div className="player-sticky">
            <MediaStage media={media} source={source} sourceError={sourceError} controls={controls} mediaRef={mediaRef} />
            <Transport controls={controls} time={time} onShortcuts={() => setShortcutsOpen(true)} />
            <Timeline
              duration={controls.duration}
              time={time}
              turns={turns}
              peaks={peaks}
              range={range}
              notes={data.notes}
              onSeek={(t) => controls.seek(t)}
              onRangeChange={setRange}
              onNote={(n) => {
                controls.seek(n.start, true);
                setFollow(true);
              }}
            />
          </div>
          {!stacked && speakerPanel}
        </section>
        <section className="player-transcript" aria-label="Transcript">
          {stacked && (
            <div className="pane-switch">
              <Segmented
                label="Show"
                value={pane}
                onChange={setPane}
                options={[
                  { value: "transcript", label: "Transcript" },
                  { value: "speakers", label: `Speakers (${voices.size})` },
                ]}
              />
            </div>
          )}
          {stacked && pane === "speakers" ? speakerPanel : transcript}
        </section>
      </SplitLayout>
      {naming && (
        <NameVoiceDialog mediaId={media.id} voice={naming} onClose={() => setNaming(null)} onSample={() => longestLine(naming)} onSaved={refresh} />
      )}
      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
