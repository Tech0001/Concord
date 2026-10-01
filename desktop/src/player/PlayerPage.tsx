import { usePopoutControls } from "./usePopoutControls.ts";
import { useStoredState } from "../lib/storage.ts";
import { nextAfterGap, speechIntervals } from "./gaps.ts";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AlertCircle, AudioLines, Circle, CircleCheck, CircleDot, Copy, FolderOpen, Keyboard, LoaderCircle, PictureInPicture2, FastForward } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { copyText } from "../lib/clipboard.ts";
import { clampRange, findMatches, indexAt, linesIn, setIn, setOut, spanRange, speakerTurns, type Range } from "../lib/range.ts";
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
import { RecordingFileDialog, fileMenu, type FileAction } from "../library/RecordingFileDialog.tsx";
import { REVIEW_LABELS } from "../library/recordingMenu.ts";
import { useApp } from "../shell/AppContext.tsx";
import { clock } from "../lib/format.ts";
import { ExportDialog } from "./ExportDialog.tsx";
import { FindBar } from "./FindBar.tsx";
import { RangeBar } from "./RangeBar.tsx";
import { useLineSelection } from "./useLineSelection.ts";
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
import { buildVoices, groupVoices, type Voice } from "./voices.ts";
import "./player.css";
import { SummaryPane } from "../ai/SummaryPane.tsx";

/** Saves the playback position every 10 s of movement, on pause, and when leaving. One failure toast per recording. */
function usePositionSaver(id: string, time: TimeStore, playing: boolean, ready: boolean, onFail: (e: unknown) => void) {
  const last = useRef<number | null>(null);
  const failed = useRef(false);
  const canSave = useRef(false);
  if (ready) canSave.current = true;
  const save = useCallback(
    (force = false) => {
      if (!canSave.current) return;
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
  const { revision, refresh, setPageTitle, navigate, openNote } = useApp();
  const toast = useToast();
  const stacked = useMediaQuery(TABLET);
  const [data, setData] = useState<Recording>();
  const [loadError, setLoadError] = useState("");
  const [starred, setStarred] = useState(false);
  const [review, setReview] = useState<ReviewState>("unreviewed");
  const [source, setSource] = useState("");
  const [fileAction, setFileAction] = useState<FileAction>();
  const [fileRevision, setFileRevision] = useState(0);
  const resumeFile = useRef<{source:string;at:number} | null>(null);
  const [sourceError, setSourceError] = useState("");
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [range, setRange] = useState<Range | null>(null);
  const [naming, setNaming] = useState<Voice | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [pane, setPane] = useState<"transcript" | "speakers" | "summary">("transcript");
  const [loop, setLoop] = useState(false);
  const [playingRange, setPlayingRange] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [mediaElement, setMediaElement] = useState<HTMLMediaElement | null>(null);
  const attachMedia = useCallback((el: HTMLMediaElement | null) => {
    mediaRef.current = el;
    setMediaElement(el);
  }, []);
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
  }, [id, fileRevision]);
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
  }, [id, kind, fileRevision]);
  useEffect(() => {
    if (!data) return;
    setPageTitle(data.media.title);
    return () => setPageTitle(null);
  }, [data, setPageTitle]);

  const localControls = useMedia(mediaElement, time, data?.media.duration ?? 0, source);
  const [skipGaps, setSkipGaps] = useStoredState("player-skip-gaps-v1", false, value => typeof value === "boolean");
  const detached = usePopoutControls(id, localControls, mediaElement, time, skipGaps && !playingRange);
  const controls = detached.controls;
  const started = useRef("");
  const requestedAt = useRef(at);
  useEffect(() => {
    if (!controls.ready || !data) return;
    if (resumeFile.current && source && source !== resumeFile.current.source) {
      controls.seek(resumeFile.current.at);resumeFile.current=null;
    }
    if (started.current !== id) {
      started.current = id;
      requestedAt.current = at;
      if (!detached.active || at !== undefined) controls.seek(at ?? (data.media.position > 5 ? data.media.position : 0));
    } else if (at !== requestedAt.current) {
      requestedAt.current = at;
      if (at !== undefined) controls.seek(at);
    }
  }, [controls, data, id, at, source, detached.active]);
  const onSaveFail = useCallback((e: unknown) => toast.error(`Couldn't save your place in this recording: ${errorMessage(e)}`), [toast]);
  usePositionSaver(id, time, controls.playing, controls.ready, onSaveFail);

  const lines = useMemo(() => data?.segments ?? [], [data]);
  const intervals = useMemo(() => speechIntervals(lines), [lines]);
  useEffect(() => {
    if (detached.active || !skipGaps || !controls.playing || playingRange || !intervals.length) return;
    let lastTarget = -1, lastJump = 0;
    const check = () => {
      const target = nextAfterGap(intervals, time.get());
      if (target === null || (target === lastTarget && performance.now() - lastJump < 1000)) return;
      lastTarget = target; lastJump = performance.now(); controls.seek(target);
    };
    check();return time.subscribe(check);
  }, [skipGaps, controls, playingRange, intervals, time, detached.active]);
  useEffect(() => {
    if (detached.active && controls.ready) detached.setGaps(skipGaps && !playingRange);
  }, [detached.active, controls.ready, detached.setGaps, skipGaps, playingRange]);
  const rangeExit = useRef({ active: detached.active, playingRange, controls, setGaps: detached.setGaps, skipGaps });
  rangeExit.current = { active: detached.active, playingRange, controls, setGaps: detached.setGaps, skipGaps };
  useEffect(() => () => {
    const last = rangeExit.current;
    if (last.active && last.playingRange) { last.controls.pause(); last.setGaps(last.skipGaps); }
  }, []);
  const voices = useMemo(() => (data ? buildVoices(data.assignments, data.segments) : new Map<string, Voice>()), [data]);
  const people = useMemo(() => groupVoices(voices), [voices]);
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
  const duration = controls.duration || data?.media.duration || 0;
  const onRange = useCallback(
    (r: Range) => {
      setFollow(false);
      setRange(clampRange(r, duration));
      setPlayingRange(false);
    },
    [duration],
  );
  const seekAndPlayLine = useCallback((index: number) => seekLine(index, true), [seekLine]);
  const selection = useLineSelection({
    lines,
    scroller,
    onRange,
    onSeekLine: seekAndPlayLine,
  });
  const onLine: (index: number, e: MouseEvent) => void = selection.handleLine;

  // Find: highlight every match, scroll to the first as you type, step with Enter or the arrows.
  const matches = useMemo(() => findMatches(lines, query), [lines, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const revealLine = useCallback((index: number) => {
    scroller.current?.querySelector<HTMLElement>(`[data-line="${index}"]`)?.scrollIntoView({ block: "center" });
  }, []);
  useEffect(() => {
    setMatchIndex(0);
    if (matches.length) {
      setFollow(false);
      revealLine(matches[0]);
    }
    // A background refresh must not reset the user's current match.
  }, [query, revealLine]);
  const stepFind = (delta: number) => {
    if (!matches.length) return;
    const next = (matchIndex + delta + matches.length) % matches.length;
    setMatchIndex(next);
    controls.seek(lines[matches[next]].start);
    setFollow(false);
    revealLine(matches[next]);
  };

  const bounds = useMemo(() => (range ? linesIn(lines, range) : null), [lines, range]);
  const lineState = useCallback(
    (i: number) => {
      const inRange = !!bounds && i >= bounds[0] && i <= bounds[1];
      const edge: "" | "start" | "end" | "both" = !inRange
        ? ""
        : i === bounds![0] && i === bounds![1]
          ? "both"
          : i === bounds![0]
            ? "start"
            : i === bounds![1]
              ? "end"
              : "";
      return {
        inRange,
        edge,
        query: matchSet.has(i) ? query : "",
        activeMatch: matches[matchIndex] === i,
      };
    },
    [bounds, matchSet, query, matches, matchIndex],
  );

  // Range playback stops (or loops) at the range end; seeking away ends it.
  useEffect(() => {
    if (!range || !playingRange) return;
    return time.subscribe(() => {
      const t = time.get();
      if (t >= range.end - 0.04) {
        if (loop) controls.seek(range.start, true);
        else {
          controls.pause();
          setPlayingRange(false);
        }
      } else if (t < range.start - 0.5) setPlayingRange(false);
    });
  }, [range, playingRange, loop, time, controls]);
  const playRange = () => {
    if (!range) return;
    controls.seek(range.start, true);
    setPlayingRange(true);
    setFollow(true);
  };
  const stopRange = () => {
    controls.pause();
    setPlayingRange(false);
  };
  const clearRange = () => {
    setRange(null);
    setPlayingRange(false);
    selection.setAnchor(null);
    selection.setSelecting(false);
    document.getSelection()?.removeAllRanges();
  };
  const openSavedNote = useCallback(async (id: string) => {
    try { const data = await api.research(); const note = data.notes.find(n => n.id === id); if (note) openNote(note); }
    catch (e) { toast.error(e); }
  }, [openNote, toast]);
  const onVoice = useCallback((local: string) => setNaming(voices.get(local) ?? null), [voices]);
  const firstLine = (voice: Voice) => {
    const index = lines.findIndex((l) => voice.locals.includes(l.speaker ?? ""));
    if (index >= 0) seekLine(index, false);
    if (stacked) setPane("transcript");
  };
  const longestLine = (voice: Voice) => {
    let best = -1;
    lines.forEach((l, i) => {
      if (voice.locals.includes(l.speaker ?? "") && (best < 0 || l.end - l.start > lines[best].end - lines[best].start)) best = i;
    });
    if (best >= 0) seekLine(best, true);
  };
  const stepLine = (delta: number) => {
    if (!lines.length) return;
    const i = Math.min(lines.length - 1, Math.max(0, indexAt(lines, time.get()) + delta));
    seekLine(i, false);
  };
  const toggleFullscreen = () => {
    if (detached.active) { void api.popoutFocus().catch(toast.error); return; }
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
      {
        key: "i",
        run: () => setRange((r) => setIn(r, time.get(), lines, duration)),
      },
      {
        key: "o",
        run: () => setRange((r) => setOut(r, time.get(), lines, duration)),
      },
      { key: "p", run: playRange },
      { key: "l", run: () => setLoop((v) => !v) },
      { key: "Escape", run: clearRange },
      {
        key: "f",
        mod: true,
        global: true,
        run: () => findInput.current?.focus(),
      },
    ],
    !!data,
  );

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __concordTest: unknown }).__concordTest = {
      selectRange: (a: number, b: number) => onRange(spanRange(lines, a, b)),
      openExport: () => setExportOpen(true),
      find: (q: string) => setQuery(q),
    };
  }, [lines, onRange]);

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
  const openFileAction = (action:FileAction) => { controls.pause(); setFileAction(action); };
  const menu: MenuEntry[] = [
    ...fileMenu(media, openFileAction),
    {label:"Extract audio",icon:AudioLines,disabled:!media.path||media.status==="archived",onSelect:()=>{if(media.path){mediaElement?.pause();navigate({page:"tools",tab:"extract",source:media.path});}}},
    { kind: "label", label: "Review" },
    ...(Object.keys(REVIEW_LABELS) as ReviewState[]).map((s) => ({
      label: REVIEW_LABELS[s],
      icon: { unreviewed: Circle, in_review: CircleDot, reviewed: CircleCheck }[s],
      checked: review === s,
      onSelect: () => void setReviewState(s),
    })),
    { kind: "separator" },
    { kind: "label", label: "Category" },
    ...(["personal", "work"] as const).map(category => ({
      label: category === "work" ? "Work" : "Personal", checked: (media.category ?? "personal") === category,
      onSelect: () => { void api.setCategory(media.id, category).then(refresh).catch(toast.error); },
    })),
    { kind: "separator" },
    {
      label: "Show file in folder",
      icon: FolderOpen,
      disabled: !media.path,
      onSelect: () => media.path && api.reveal(media.path).catch(toast.error),
    },
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
    {
      label: "Keyboard shortcuts",
      icon: Keyboard,
      hint: "?",
      onSelect: () => setShortcutsOpen(true),
    },
  ];
  const copyRange = async () => {
    if (!range) return;
    try {
      await copyText(await api.transcriptText(media.id, range.start, range.end, "txt"));
      toast.success("Passage copied");
    } catch (e) {
      toast.error(e);
    }
  };
  const saveRangeNote = () => {
    if (!range) return;
    const quote = bounds
      ? lines
          .slice(bounds[0], bounds[1] + 1)
          .map((l) => l.text.trim())
          .join(" ")
      : "";
    openNote({
      title: `${media.title} · ${clock(range.start)}`,
      body: "",
      quote,
      media_id: media.id,
      media_title: media.title,
      start: range.start,
      end: range.end,
    });
  };
  const mediaAvailable = !!source && !sourceError && !controls.error;
  const speakerPanel = <SpeakerPanel voices={voices} onName={setNaming} onFirstLine={firstLine} />;
  const transcript = (
    <Transcript
      lines={lines}
      notes={data.notes}
      onNote={openSavedNote}
      voices={voices}
      time={time}
      follow={follow}
      setFollow={setFollow}
      onLine={onLine}
      onVoice={onVoice}
      scroller={scroller}
      stacked={stacked}
      lineState={lineState}
      press={selection.pressHandlers}
      header={<FindBar ref={findInput} query={query} setQuery={setQuery} index={matchIndex} total={matches.length} step={stepFind} />}
      banner={
        selection.selecting && (
          <div className="select-banner">
            <span>Tap lines to extend the selection</span>
            <Button size="sm" variant="primary" onClick={() => selection.setSelecting(false)}>
              Done
            </Button>
          </div>
        )
      }
      footer={
        range && (
          <RangeBar
            range={range}
            playing={playingRange && controls.playing}
            loop={loop}
            onPlay={playRange}
            onStop={stopRange}
            onLoop={() => setLoop((v) => !v)}
            onCopy={() => void copyRange()}
            onExport={() => setExportOpen(true)}
            onSaveNote={saveRangeNote}
            onClear={clearRange}
          />
        )
      }
    />
  );
  return (
    <div className="player">
      {fileAction && <RecordingFileDialog media={media} action={fileAction} onClose={()=>setFileAction(undefined)} onSaved={action=>{refresh();if(action!=="title"){resumeFile.current={source,at:time.get()};setFileRevision(v=>v+1);}}}/>}
      <PlayerHeader recording={data} starred={starred} onStar={() => void star()} menu={menu} />
      <SplitLayout>
        <section className="player-media" aria-label="Playback">
          <div className="player-sticky">
            <MediaStage media={media} source={source} sourceError={sourceError} controls={controls} mediaRef={attachMedia} detached={detached.active} onReturn={() => void api.popoutClose(true).catch(toast.error)} />
            {sourceError && <Button onClick={()=>openFileAction("relink")}>Locate media file</Button>}
            <Transport controls={controls} time={time} onShortcuts={() => setShortcutsOpen(true)} />
            <div className="player-options">
              {media.kind === "video" && <Button size="sm" icon={PictureInPicture2} disabled={detached.opening || !controls.ready} onClick={() => detached.active ? void api.popoutFocus().catch(toast.error) : void detached.open()}>{detached.opening ? "Opening video…" : detached.active ? "Show pop-out" : "Pop out video"}</Button>}
              {!!lines.length && <Button size="sm" variant={skipGaps ? "secondary" : "ghost"} icon={FastForward} aria-pressed={skipGaps} title="Skip gaps longer than 1.25 seconds between transcript passages. This can skip untranscribed speech." onClick={() => setSkipGaps(value => !value)}>Skip transcript gaps</Button>}
            </div>
            <Timeline
              duration={controls.duration}
              time={time}
              turns={turns}
              peaks={peaks}
              range={range}
              notes={data.notes}
              onSeek={(t) => {
                controls.seek(t);
                if (range && (t < range.start || t > range.end)) setPlayingRange(false);
              }}
              onRangeChange={onRange}
              onNote={(n) => {
                controls.seek(n.start, true);
                setFollow(true);
              }}
            />
          </div>
          {!stacked && speakerPanel}
        </section>
        <section className="player-transcript" aria-label="Transcript">
          {(
            <div className="pane-switch">
              <Segmented
                label="Show"
                value={pane}
                onChange={setPane}
                options={[
                  { value: "transcript", label: "Transcript" },
                  ...(stacked ? [{ value: "speakers" as const, label: `Speakers (${people.length})` }] : []),
                  { value: "summary", label: "Summary" },
                ]}
              />
            </div>
          )}
          {pane === "summary" ? <SummaryPane id={id} title={media.title} /> : stacked && pane === "speakers" ? speakerPanel : transcript}
        </section>
      </SplitLayout>
      {naming && (
        <NameVoiceDialog
          mediaId={media.id}
          voice={naming}
          voices={[...voices.values()]}
          onClose={() => setNaming(null)}
          onSample={() => longestLine(naming)}
          onSaved={refresh}
        />
      )}
      <ShortcutSheet open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      {range && (
        <ExportDialog
          open={exportOpen}
          onOpenChange={setExportOpen}
          recording={data}
          range={range}
          onRange={onRange}
          mediaAvailable={mediaAvailable}
          playhead={() => time.get()}
        />
      )}
    </div>
  );
}
