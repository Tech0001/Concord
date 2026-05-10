import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TagChip, TagPicker } from "@/components/TagPicker";
import { SpeakerLabelDialog } from "@/components/SpeakerLabelDialog";
import { apiRequest } from "@/lib/queryClient";
import { Bookmark, BookmarkPlus, Calendar, ChevronDown, ChevronUp, Clock, Download, FileText, Loader2, Play, Radio, RefreshCw, Scissors, Search, Sparkles, X } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface VideoDrawerEntry {
  video_id: string;
  channel_id: string;
  channel_name?: string | null;
  title: string;
  upload_date?: string | null;
  duration?: number | null;
  status?: string;
  is_live?: number;
  video_path?: string | null;
  md_path?: string | null;
  word_count?: number;
}

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
}

interface VideoStreamInfo {
  codec: string | null;
  codecLong: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  container: string | null;
  fileSizeMb: number | null;
}

function codecDisplayName(codec: string | null): string {
  if (!codec) return "";
  const lc = codec.toLowerCase();
  if (lc.includes("av1") || lc.includes("av01")) return "AV1";
  if (lc.includes("vp9")) return "VP9";
  if (lc.includes("h264") || lc.includes("avc")) return "H.264";
  if (lc.includes("hevc") || lc.includes("h265")) return "HEVC";
  return codec.toUpperCase();
}

interface RelatedClip {
  id: string;
  video_id: string;
  channel_id: string;
  title: string;
  channel_name: string | null;
  upload_date: string | null;
  start_seconds: number;
  end_seconds: number;
  quote: string;
  note: string | null;
  created_at: string;
  tags: string[];
  overlap?: number;
}

interface TagOption {
  tag: string;
  count: number;
}

interface VideoDrawerProps {
  open: boolean;
  video: VideoDrawerEntry | null;
  initialSeconds?: number;
  initialSegmentIndex?: number;
  onOpenChange: (open: boolean) => void;
}

function formatUploadDate(uploadDate?: string | null): string {
  if (!uploadDate) return "No upload date";
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }
  return uploadDate;
}

function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function formatDuration(seconds?: number | null): string {
  if (!seconds || seconds <= 0) return "";
  return formatTimestamp(seconds);
}

function parseTimestampInput(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const parts = trimmed.split(":").map(part => Number(part));
  if (parts.some(part => !Number.isFinite(part) || part < 0)) return Number.NaN;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number.NaN;
}

function videoKey(video: VideoDrawerEntry | null): string {
  return video ? `${video.channel_id}:${video.video_id}` : "";
}

export function VideoDrawer({ open, video, initialSeconds = 0, initialSegmentIndex, onOpenChange }: VideoDrawerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);
  const segmentRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  /** Per-video map: local label "S0" → { id, name, color } when assigned. */
  const [speakerMap, setSpeakerMap] = useState<Record<string, { id: string; name: string; color: string | null }>>({});
  const [labelDialog, setLabelDialog] = useState<{ localSpeaker: string; currentSpeakerId: string | null } | null>(null);
  const [videoInfo, setVideoInfo] = useState<VideoStreamInfo | null>(null);
  const [loadingSegments, setLoadingSegments] = useState(false);
  const [segmentError, setSegmentError] = useState("");
  const [activeSeconds, setActiveSeconds] = useState(initialSeconds);
  const [clipSegmentIndex, setClipSegmentIndex] = useState<number | null>(null);
  const [clipNote, setClipNote] = useState("");
  const [savingClip, setSavingClip] = useState(false);
  const [transcriptQuery, setTranscriptQuery] = useState("");
  const [searchCursor, setSearchCursor] = useState(0);
  const [selectionStartIndex, setSelectionStartIndex] = useState<number | null>(null);
  const [selectionEndIndex, setSelectionEndIndex] = useState<number | null>(null);
  const [rangeNote, setRangeNote] = useState("");
  const [segClipTags, setSegClipTags] = useState<string[]>([]);
  const [rangeClipTags, setRangeClipTags] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [byTagClips, setByTagClips] = useState<RelatedClip[]>([]);
  const [sameVideoClips, setSameVideoClips] = useState<RelatedClip[]>([]);
  const [loadingRelated, setLoadingRelated] = useState(false);
  const [notes, setNotes] = useState("");
  const [aiSummary, setAiSummary] = useState("");
  const [aiSummaryModel, setAiSummaryModel] = useState<string | null>(null);
  const [regeneratingSummary, setRegeneratingSummary] = useState(false);
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved">("idle");
  const notesTimerRef = useRef<number | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [exportStartInput, setExportStartInput] = useState(formatTimestamp(initialSeconds));
  const [exportEndInput, setExportEndInput] = useState(formatTimestamp(initialSeconds + 60));
  const [exportMode, setExportMode] = useState<"fast" | "accurate">("fast");
  const [exportQuality, setExportQuality] = useState("same");
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  const loadTagOptions = async () => {
    try {
      const response = await apiRequest("GET", `/api/clips/tags?t=${Date.now()}`);
      const data = await response.json() as { tags?: TagOption[] };
      setTagOptions(data.tags || []);
    } catch {
      setTagOptions([]);
    }
  };

  const streamUrl = useMemo(() => {
    if (!video?.video_path) return "";
    return `/api/videos/library/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}/stream`;
  }, [video]);

  useEffect(() => {
    setActiveSeconds(initialSeconds);
    setClipSegmentIndex(null);
    setClipNote("");
    setSegClipTags([]);
    setRangeClipTags([]);
    setTranscriptQuery("");
    setSearchCursor(0);
    setSelectionStartIndex(null);
    setSelectionEndIndex(null);
    setRangeNote("");
    setExportStartInput(formatTimestamp(initialSeconds));
    setExportEndInput(formatTimestamp(initialSeconds + 60));
    setExportOpen(false);
  }, [initialSeconds, initialSegmentIndex, videoKey(video)]);

  // Per-video speaker mapping. Refreshes on drawer open and after each
  // assign/unassign so the chip labels update in place.
  const loadSpeakerMap = async () => {
    if (!video) return;
    try {
      const r = await apiRequest(
        "GET",
        `/api/videos/library/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}/speakers?t=${Date.now()}`,
      );
      const data = await r.json() as { speakers?: { local_speaker: string; speaker_id: string; name: string; display_color: string | null }[] };
      const map: Record<string, { id: string; name: string; color: string | null }> = {};
      for (const s of data.speakers || []) {
        map[s.local_speaker] = { id: s.speaker_id, name: s.name, color: s.display_color };
      }
      setSpeakerMap(map);
    } catch { setSpeakerMap({}); }
  };

  useEffect(() => {
    if (!open || !video) return;

    const loadSegments = async () => {
      setLoadingSegments(true);
      setSegmentError("");
      try {
        const response = await apiRequest(
          "GET",
          `/api/videos/library/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}/transcript?t=${Date.now()}`,
        );
        const data = await response.json() as {
          segments?: TranscriptSegment[];
          notes?: string;
          aiSummary?: string;
          aiSummaryModel?: string | null;
          video?: VideoStreamInfo | null;
        };
        setSegments(data.segments || []);
        setNotes(data.notes || "");
        setAiSummary(data.aiSummary || "");
        setAiSummaryModel(data.aiSummaryModel ?? null);
        setNotesStatus("idle");
        setVideoInfo(data.video ?? null);
      } catch (error: any) {
        setSegments([]);
        setSegmentError(error.message || "Could not load transcript timestamps");
      } finally {
        setLoadingSegments(false);
      }
    };

    loadSegments();
    loadSpeakerMap();
  }, [open, videoKey(video)]);

  // Debounced notes save: 600ms after last keystroke.
  const handleNotesChange = (value: string) => {
    setNotes(value);
    setNotesStatus("saving");
    if (notesTimerRef.current) window.clearTimeout(notesTimerRef.current);
    if (!video) return;
    const channelId = video.channel_id;
    const videoId = video.video_id;
    notesTimerRef.current = window.setTimeout(async () => {
      try {
        await apiRequest(
          "PATCH",
          `/api/videos/library/${encodeURIComponent(channelId)}/${encodeURIComponent(videoId)}/notes`,
          { notes: value },
        );
        setNotesStatus("saved");
      } catch {
        setNotesStatus("idle");
      }
    }, 600);
  };

  useEffect(() => {
    return () => {
      if (notesTimerRef.current) window.clearTimeout(notesTimerRef.current);
    };
  }, []);

  const loadRelatedClips = async () => {
    if (!open || !video) return;
    setLoadingRelated(true);
    try {
      const response = await apiRequest(
        "GET",
        `/api/clips/related/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}?t=${Date.now()}`,
      );
      const data = await response.json() as { byTags?: RelatedClip[]; sameVideo?: RelatedClip[] };
      setByTagClips(data.byTags || []);
      setSameVideoClips(data.sameVideo || []);
    } catch {
      setByTagClips([]);
      setSameVideoClips([]);
    } finally {
      setLoadingRelated(false);
    }
  };

  useEffect(() => {
    loadRelatedClips();
    if (open) loadTagOptions();
  }, [open, videoKey(video)]);

  const seekTo = (seconds: number, autoplay = true) => {
    setActiveSeconds(seconds);
    const player = videoRef.current;
    if (!player) return;
    player.currentTime = Math.max(0, seconds);
    if (autoplay) {
      player.play().catch(() => {});
    }
  };

  const onLoadedMetadata = () => {
    const player = videoRef.current;
    if (player && Number.isFinite(player.duration) && player.duration > 0) {
      setVideoDuration(player.duration);
    }
    if (activeSeconds > 0) seekTo(activeSeconds, false);
  };

  // Reset duration when switching videos so the strip doesn't briefly render
  // markers against the previous video's length.
  useEffect(() => {
    setVideoDuration(0);
  }, [videoKey(video)]);

  const effectiveDuration = videoDuration || video?.duration || 0;

  // Build a sorted list of clipped time ranges for "already clipped" hints
  // on the transcript. A segment is considered clipped if it overlaps any
  // saved clip's [start, end] interval.
  const clippedRanges = useMemo(() => {
    return sameVideoClips
      .map(clip => ({ start: clip.start_seconds, end: clip.end_seconds }))
      .sort((a, b) => a.start - b.start);
  }, [sameVideoClips]);

  const isSegmentClipped = (segment: TranscriptSegment) => {
    for (const range of clippedRanges) {
      if (range.start >= segment.end) break;
      if (range.end > segment.start) return true;
    }
    return false;
  };

  // Return every saved clip whose [start, end] overlaps this segment.
  // Used to render inline tag pills + note for clipped transcript segments
  // so the user can see what they tagged at a glance.
  const clipsForSegment = (segment: TranscriptSegment): RelatedClip[] => {
    const matches: RelatedClip[] = [];
    for (const clip of sameVideoClips) {
      if (clip.start_seconds >= segment.end) continue;
      if (clip.end_seconds <= segment.start) continue;
      matches.push(clip);
    }
    return matches;
  };

  const closestSegmentIndex = useMemo(() => {
    if (!segments.length) return -1;
    const current = Math.max(0, activeSeconds);
    let closest = 0;
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].start <= current) closest = i;
      if (segments[i].start > current) break;
    }
    return closest;
  }, [segments, activeSeconds]);

  const transcriptMatches = useMemo(() => {
    const query = transcriptQuery.trim().toLowerCase();
    if (!query) return [];
    return segments
      .map((segment, index) => segment.text.toLowerCase().includes(query) ? index : -1)
      .filter(index => index >= 0);
  }, [segments, transcriptQuery]);

  const selectedSearchIndex = transcriptMatches.length ? transcriptMatches[Math.min(searchCursor, transcriptMatches.length - 1)] : -1;
  const highlightedSegmentIndex = selectedSearchIndex >= 0 ? selectedSearchIndex : initialSegmentIndex ?? closestSegmentIndex;

  const rangeBounds = useMemo(() => {
    if (selectionStartIndex === null) return null;
    const end = selectionEndIndex ?? selectionStartIndex;
    return {
      start: Math.min(selectionStartIndex, end),
      end: Math.max(selectionStartIndex, end),
    };
  }, [selectionEndIndex, selectionStartIndex]);

  const exportStartSeconds = parseTimestampInput(exportStartInput);
  const exportEndSeconds = parseTimestampInput(exportEndInput);
  const exportValid = Number.isFinite(exportStartSeconds)
    && Number.isFinite(exportEndSeconds)
    && exportStartSeconds >= 0
    && exportEndSeconds > exportStartSeconds;

  /**
   * Scroll *only* the transcript list (not the outer Sheet) so playback
   * never drags the video out of view. `align="top"` puts the segment at
   * the top of the visible area (with a small padding) — used for the live
   * playback follow. `align="center"` is used for jumps from search.
   */
  const scrollTranscriptTo = (index: number, align: "top" | "center" = "top") => {
    const container = transcriptListRef.current;
    const node = segmentRefs.current[index];
    if (!container || !node) return;
    const containerRect = container.getBoundingClientRect();
    const nodeRect = node.getBoundingClientRect();
    const delta = nodeRect.top - containerRect.top;
    const offset = align === "center"
      ? delta - (container.clientHeight - node.clientHeight) / 2
      : delta - 8;
    container.scrollTo({ top: container.scrollTop + offset, behavior: "smooth" });
  };

  // User-initiated jumps (search hits, deep-link via initialSegmentIndex):
  // center the target so context is visible.
  useEffect(() => {
    if (!open || loadingSegments) return;
    const target = selectedSearchIndex >= 0 ? selectedSearchIndex : initialSegmentIndex ?? -1;
    if (target < 0) return;
    const id = window.setTimeout(() => scrollTranscriptTo(target, "center"), 100);
    return () => window.clearTimeout(id);
  }, [open, loadingSegments, selectedSearchIndex, initialSegmentIndex]);

  // Playback follow: keep the current line pinned near the top of the
  // transcript list as the video plays. Only the inner container scrolls,
  // so the video and notes above remain steady.
  useEffect(() => {
    if (!open || loadingSegments) return;
    if (closestSegmentIndex < 0) return;
    scrollTranscriptTo(closestSegmentIndex, "top");
  }, [open, loadingSegments, closestSegmentIndex]);

  const jumpSearch = (direction: 1 | -1) => {
    if (!transcriptMatches.length) return;
    const next = (searchCursor + direction + transcriptMatches.length) % transcriptMatches.length;
    setSearchCursor(next);
    const segment = segments[transcriptMatches[next]];
    if (segment) seekTo(segment.start, false);
  };

  const useSelectedRangeForExport = () => {
    if (!rangeBounds) return;
    const start = segments[rangeBounds.start]?.start;
    const end = segments[rangeBounds.end]?.end;
    if (Number.isFinite(start) && Number.isFinite(end)) {
      setExportStartInput(formatTimestamp(start));
      setExportEndInput(formatTimestamp(end));
    }
  };

  const exportSegment = async () => {
    if (!video || !exportValid) return;
    setExporting(true);
    try {
      const response = await apiRequest(
        "POST",
        `/api/videos/library/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}/export-segment`,
        {
          startSeconds: exportStartSeconds,
          endSeconds: exportEndSeconds,
          mode: exportMode,
          quality: exportQuality,
        },
      );
      const data = await response.json() as { outputPath?: string; mode?: string; quality?: string };
      toast({
        title: "Video segment exported",
        description: data.outputPath || `${formatTimestamp(exportStartSeconds)} - ${formatTimestamp(exportEndSeconds)}`,
      });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Export failed", description: error.message });
    } finally {
      setExporting(false);
    }
  };

  const saveClip = async (segment: TranscriptSegment, index: number) => {
    if (!video) return;
    setSavingClip(true);
    try {
      await apiRequest("POST", "/api/clips", {
        videoId: video.video_id,
        channelId: video.channel_id,
        title: video.title,
        channelName: video.channel_name || video.channel_id,
        uploadDate: video.upload_date || null,
        startSeconds: segment.start,
        endSeconds: segment.end,
        quote: segment.text,
        note: clipSegmentIndex === index ? clipNote : "",
        tags: clipSegmentIndex === index ? segClipTags : [],
      });
      toast({
        title: "Clip saved",
        description: `${formatTimestamp(segment.start)} - ${formatTimestamp(segment.end)}`,
      });
      setClipSegmentIndex(null);
      setClipNote("");
      setSegClipTags([]);
      await Promise.all([loadRelatedClips(), loadTagOptions()]);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Clip save failed", description: error.message });
    } finally {
      setSavingClip(false);
    }
  };

  const saveSelectedRange = async () => {
    if (!video || !rangeBounds) return;
    const selected = segments.slice(rangeBounds.start, rangeBounds.end + 1);
    if (!selected.length) return;

    const first = selected[0];
    const last = selected[selected.length - 1];
    setSavingClip(true);
    try {
      await apiRequest("POST", "/api/clips", {
        videoId: video.video_id,
        channelId: video.channel_id,
        title: video.title,
        channelName: video.channel_name || video.channel_id,
        uploadDate: video.upload_date || null,
        startSeconds: first.start,
        endSeconds: last.end,
        quote: selected.map(segment => segment.text).join("\n\n"),
        note: rangeNote,
        tags: rangeClipTags,
      });
      toast({
        title: "Clip saved",
        description: `${formatTimestamp(first.start)} - ${formatTimestamp(last.end)}`,
      });
      setSelectionStartIndex(null);
      setSelectionEndIndex(null);
      setRangeNote("");
      setRangeClipTags([]);
      await Promise.all([loadRelatedClips(), loadTagOptions()]);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Clip save failed", description: error.message });
    } finally {
      setSavingClip(false);
    }
  };

  const seekRelatedClip = (clip: RelatedClip) => {
    seekTo(clip.start_seconds);
    const index = segments.findIndex(segment => segment.start <= clip.start_seconds && segment.end >= clip.start_seconds);
    const fallbackIndex = segments.findIndex(segment => segment.start >= clip.start_seconds);
    const targetIndex = index >= 0 ? index : fallbackIndex;
    if (targetIndex >= 0) {
      window.setTimeout(() => scrollTranscriptTo(targetIndex), 100);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-2xl lg:max-w-3xl">
        {video ? (
          <>
            <SheetHeader className="border-b pr-12">
              <SheetTitle className="line-clamp-2 text-base">{video.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{video.channel_name || video.channel_id}</span>
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  {formatUploadDate(video.upload_date)}
                </span>
                {formatDuration(video.duration) && (
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDuration(video.duration)}
                  </span>
                )}
                {!!video.is_live && (
                  <span className="inline-flex items-center gap-1">
                    <Radio className="h-3 w-3" />
                    Live
                  </span>
                )}
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-4 p-4">
              {streamUrl ? (
                <video
                  key={streamUrl}
                  ref={videoRef}
                  controls
                  preload="metadata"
                  onLoadedMetadata={onLoadedMetadata}
                  onTimeUpdate={event => setActiveSeconds(event.currentTarget.currentTime)}
                  className="aspect-video w-full rounded-md border bg-black"
                  src={streamUrl}
                />
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-md border bg-muted text-sm text-muted-foreground">
                  No saved video file for this record.
                </div>
              )}

              {streamUrl && effectiveDuration > 0 && (
                <ClipTimeline
                  duration={effectiveDuration}
                  clips={sameVideoClips}
                  currentSeconds={activeSeconds}
                  onSeek={seekTo}
                />
              )}

              <div className="flex flex-wrap gap-2">
                {video.status && <Badge variant="outline">{video.status}</Badge>}
                {!!video.word_count && <Badge variant="outline">{video.word_count} words</Badge>}
                {video.video_path && <Badge variant="outline">video</Badge>}
                {video.md_path && <Badge variant="outline">transcript</Badge>}
                {videoInfo?.codec && (
                  <Badge
                    variant="secondary"
                    title={[
                      videoInfo.codecLong || codecDisplayName(videoInfo.codec),
                      videoInfo.width && videoInfo.height ? `${videoInfo.width}×${videoInfo.height}` : "",
                      videoInfo.fps ? `${videoInfo.fps} fps` : "",
                      videoInfo.container ? `.${videoInfo.container}` : "",
                    ].filter(Boolean).join(" · ")}
                  >
                    {codecDisplayName(videoInfo.codec)}
                    {videoInfo.height ? ` ${videoInfo.height}p` : ""}
                  </Badge>
                )}
                {videoInfo?.fileSizeMb != null && (
                  <Badge variant="outline">{videoInfo.fileSizeMb} MB</Badge>
                )}
              </div>

              <div className="rounded-md border">
                <button
                  type="button"
                  onClick={() => setExportOpen(open => !open)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-accent"
                  aria-expanded={exportOpen}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <Scissors className="h-4 w-4" />
                    Export Video Segment
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={exportValid ? "outline" : "destructive"}>
                      {exportValid
                        ? `${formatTimestamp(exportStartSeconds)} - ${formatTimestamp(exportEndSeconds)}`
                        : "Invalid range"}
                    </Badge>
                    {exportOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                  </div>
                </button>

                {exportOpen && (
                  <div className="space-y-3 border-t p-3">
                    <div className="grid gap-2 lg:grid-cols-[1fr_1fr_135px_115px_auto]">
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground" htmlFor="export-start">Start</label>
                        <div className="flex gap-1">
                          <Input
                            id="export-start"
                            value={exportStartInput}
                            onChange={event => setExportStartInput(event.target.value)}
                            placeholder="01:05"
                            className="h-8 text-xs"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2 text-xs"
                            onClick={() => setExportStartInput(formatTimestamp(activeSeconds))}
                          >
                            Now
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground" htmlFor="export-end">End</label>
                        <div className="flex gap-1">
                          <Input
                            id="export-end"
                            value={exportEndInput}
                            onChange={event => setExportEndInput(event.target.value)}
                            placeholder="02:34"
                            className="h-8 text-xs"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 px-2 text-xs"
                            onClick={() => setExportEndInput(formatTimestamp(activeSeconds))}
                          >
                            Now
                          </Button>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">Mode</label>
                        <Select value={exportMode} onValueChange={value => setExportMode(value as "fast" | "accurate")}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="fast">Fast copy</SelectItem>
                            <SelectItem value="accurate">Accurate</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">Quality</label>
                        <Select value={exportQuality} onValueChange={setExportQuality}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="same">Source</SelectItem>
                            <SelectItem value="480">480p</SelectItem>
                            <SelectItem value="720">720p</SelectItem>
                            <SelectItem value="1080">1080p</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-end gap-1">
                        {rangeBounds && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 whitespace-nowrap text-xs"
                            onClick={useSelectedRangeForExport}
                          >
                            Use selected
                          </Button>
                        )}
                        <Button
                          size="sm"
                          className="h-8 whitespace-nowrap text-xs"
                          disabled={!streamUrl || !exportValid || exporting}
                          onClick={exportSegment}
                        >
                          {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                          Export
                        </Button>
                      </div>
                    </div>
                    {exportQuality !== "same" && (
                      <p className="text-[11px] text-muted-foreground">
                        Scaling requires accurate export, so fast copy will be upgraded automatically.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <AiSummarySection
                summary={aiSummary}
                model={aiSummaryModel}
                regenerating={regeneratingSummary}
                onRegenerate={async () => {
                  if (!video) return;
                  setRegeneratingSummary(true);
                  try {
                    const r = await apiRequest(
                      "POST",
                      `/api/videos/library/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}/ai-summary/regenerate`,
                    );
                    const data = await r.json();
                    if (data.success) {
                      // Refetch the transcript meta to pick up the new summary.
                      const refetch = await apiRequest(
                        "GET",
                        `/api/videos/library/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}/transcript?t=${Date.now()}`,
                      );
                      const refreshed = await refetch.json();
                      setAiSummary(refreshed.aiSummary || "");
                      setAiSummaryModel(refreshed.aiSummaryModel ?? null);
                    }
                  } catch (err: any) {
                    setAiSummary((prev) => prev || `(regenerate failed: ${err.message})`);
                  } finally {
                    setRegeneratingSummary(false);
                  }
                }}
              />

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor="video-notes" className="text-sm font-medium">Your notes</label>
                  {notesStatus !== "idle" && (
                    <span className="text-[11px] text-muted-foreground">
                      {notesStatus === "saving" ? "Saving…" : "Saved"}
                    </span>
                  )}
                </div>
                <textarea
                  id="video-notes"
                  value={notes}
                  onChange={event => handleNotesChange(event.target.value)}
                  placeholder="Your notes about this video as a whole. Synthesis, themes, who is being interviewed, what to follow up on…"
                  rows={3}
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground/60 placeholder:font-normal placeholder:italic focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <FileText className="h-4 w-4" />
                    Transcript Timestamps
                  </div>
                  {activeSeconds > 0 && (
                    <Badge variant="secondary">{formatTimestamp(activeSeconds)}</Badge>
                  )}
                </div>

                <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-2">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                      <Input
                        value={transcriptQuery}
                        onChange={event => {
                          setTranscriptQuery(event.target.value);
                          setSearchCursor(0);
                        }}
                        placeholder="Search inside this transcript"
                        className="h-8 pl-7 text-xs"
                      />
                    </div>
                    <div className="flex items-center gap-1">
                      <Badge variant="outline" className="h-8">
                        {transcriptMatches.length ? `${Math.min(searchCursor + 1, transcriptMatches.length)} / ${transcriptMatches.length}` : "0 matches"}
                      </Badge>
                      <Button size="icon" variant="outline" className="h-8 w-8" disabled={!transcriptMatches.length} onClick={() => jumpSearch(-1)}>
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="outline" className="h-8 w-8" disabled={!transcriptMatches.length} onClick={() => jumpSearch(1)}>
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>

                  {rangeBounds && (
                    <div className="flex flex-col gap-2 border-t pt-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant="secondary">
                          {rangeBounds.end - rangeBounds.start + 1} rows selected
                        </Badge>
                        <span className="text-muted-foreground">
                          {formatTimestamp(segments[rangeBounds.start]?.start || 0)} - {formatTimestamp(segments[rangeBounds.end]?.end || 0)}
                        </span>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => {
                          setSelectionStartIndex(null);
                          setSelectionEndIndex(null);
                          setRangeNote("");
                        }}>
                          <X className="h-3 w-3" />
                          Clear
                        </Button>
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        <Input
                          value={rangeNote}
                          onChange={event => setRangeNote(event.target.value)}
                          placeholder="Optional note for selected section"
                          className="h-8 text-xs"
                        />
                        <Button size="sm" className="h-8 whitespace-nowrap text-xs" disabled={savingClip} onClick={saveSelectedRange}>
                          Save selected clip
                        </Button>
                      </div>
                      <TagPicker
                        value={rangeClipTags}
                        onChange={setRangeClipTags}
                        options={tagOptions}
                        size="sm"
                        placeholder="Add tags..."
                        onOpen={loadTagOptions}
                        quote={rangeBounds ? segments.slice(rangeBounds.start, rangeBounds.end + 1).map(s => s.text).join(" ") : ""}
                      />
                    </div>
                  )}
                </div>

                <div ref={transcriptListRef} className="max-h-[48vh] overflow-y-auto rounded-md border">
                  {segments.map((segment, index) => {
                    const active = index === closestSegmentIndex;
                    const highlighted = index === highlightedSegmentIndex;
                    const searchMatch = transcriptMatches.includes(index);
                    const selected = !!rangeBounds && index >= rangeBounds.start && index <= rangeBounds.end;
                    const takingNote = clipSegmentIndex === index;
                    const segmentClips = clipsForSegment(segment);
                    const clipped = segmentClips.length > 0;
                    // Aggregate tags across all overlapping clips, dedup'd.
                    const allTags = Array.from(new Set(segmentClips.flatMap(c => c.tags || [])));
                    // First non-empty note. Multiple-clip overlap is rare; if it
                    // happens we'll just surface the first one rather than try to
                    // render two arbitrarily.
                    const firstNote = segmentClips.map(c => c.note).find(n => n && n.trim()) || null;
                    return (
                      <div
                        key={`${segment.start}:${index}`}
                        className={`border-b px-3 py-2 text-sm last:border-b-0 ${
                          clipped ? "border-l-4 border-l-primary bg-primary/5" : ""
                        } ${
                          selected ? "bg-primary/15" : highlighted ? "bg-primary/10" : active ? "bg-accent" : ""
                        }`}
                      >
                        <button
                          ref={node => { segmentRefs.current[index] = node; }}
                          type="button"
                          onClick={() => seekTo(segment.start)}
                          className="block w-full text-left hover:text-foreground"
                        >
                          <span className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <Play className="h-3 w-3" />
                            {formatTimestamp(segment.start)} - {formatTimestamp(segment.end)}
                            {segment.speaker && (() => {
                              const known = speakerMap[segment.speaker];
                              return (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setLabelDialog({ localSpeaker: segment.speaker!, currentSpeakerId: known?.id ?? null });
                                  }}
                                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold hover:ring-2 hover:ring-foreground/30"
                                  style={known?.color
                                    ? { background: known.color, color: "white" }
                                    : { background: "var(--secondary, #e5e7eb)", color: "inherit", fontFamily: "ui-monospace, monospace" }}
                                  title={known ? `Speaker: ${known.name} (click to change)` : "Click to label this speaker"}
                                >
                                  {known?.name || segment.speaker}
                                </button>
                              );
                            })()}
                            {highlighted && <Badge variant="secondary" className="h-5">match</Badge>}
                            {searchMatch && <Badge variant="outline" className="h-5">search</Badge>}
                            {clipped && (
                              <Badge variant="default" className="h-5 gap-1">
                                <Bookmark className="h-3 w-3" />
                                Clipped
                              </Badge>
                            )}
                          </span>
                          <span className="leading-6">{segment.text}</span>
                          {clipped && (allTags.length > 0 || firstNote) && (
                            <div className="mt-2 space-y-1.5">
                              {allTags.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {allTags.map(tag => (
                                    <Badge key={tag} variant="secondary" className="h-5 font-mono text-[10px]">
                                      {tag}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              {firstNote && (
                                <div className="rounded border border-primary/20 bg-background/50 px-2 py-1 text-xs italic text-foreground">
                                  {firstNote}
                                </div>
                              )}
                            </div>
                          )}
                        </button>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => {
                              setSelectionStartIndex(index);
                              if (selectionEndIndex !== null && index > selectionEndIndex) setSelectionEndIndex(null);
                            }}
                          >
                            Start
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            onClick={() => {
                              if (selectionStartIndex === null) setSelectionStartIndex(index);
                              setSelectionEndIndex(index);
                            }}
                          >
                            End
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => {
                              const next = takingNote ? null : index;
                              setClipSegmentIndex(next);
                              setClipNote("");
                              setSegClipTags([]);
                            }}
                          >
                            <BookmarkPlus className="h-3 w-3" />
                            Clip
                          </Button>
                          {takingNote && (
                            <>
                              <Input
                                value={clipNote}
                                onChange={event => setClipNote(event.target.value)}
                                placeholder="Optional note"
                                className="h-7 min-w-[220px] flex-1 text-xs"
                              />
                              <Button
                                size="sm"
                                className="h-7 text-xs"
                                disabled={savingClip}
                                onClick={() => saveClip(segment, index)}
                              >
                                Save
                              </Button>
                            </>
                          )}
                        </div>
                        {takingNote && (
                          <TagPicker
                            value={segClipTags}
                            onChange={setSegClipTags}
                            options={tagOptions}
                            size="sm"
                            placeholder="Add tags..."
                            onOpen={loadTagOptions}
                            className="mt-2"
                            quote={segment.text}
                          />
                        )}
                      </div>
                    );
                  })}
                  {loadingSegments && (
                    <p className="p-3 text-sm text-muted-foreground">Loading transcript timestamps...</p>
                  )}
                  {!loadingSegments && segmentError && (
                    <p className="p-3 text-sm text-destructive">{segmentError}</p>
                  )}
                  {!loadingSegments && !segmentError && !segments.length && (
                    <p className="p-3 text-sm text-muted-foreground">No timestamped transcript is available for this video.</p>
                  )}
                </div>
              </div>

              <RelatedClipSection
                heading="Related Clips · By tag"
                description="From other videos that share at least one tag"
                clips={byTagClips}
                loading={loadingRelated}
                emptyMessage="No tagged clips elsewhere match. Add tags when saving to surface cross-video links."
                showOverlap
                onSelect={clip => {
                  if (clip.video_id === video.video_id && clip.channel_id === video.channel_id) {
                    seekRelatedClip(clip);
                  } else {
                    toast({
                      title: "From another video",
                      description: clip.title,
                    });
                  }
                }}
              />

              <RelatedClipSection
                heading="Same video"
                description={null}
                clips={sameVideoClips}
                loading={loadingRelated}
                emptyMessage="No saved clips for this video yet."
                onSelect={seekRelatedClip}
              />

              <div className="space-y-1 text-xs text-muted-foreground">
                {video.video_path && <div className="break-all font-mono">{video.video_path}</div>}
                {video.md_path && <div className="break-all font-mono">{video.md_path}</div>}
              </div>
            </div>
          </>
        ) : (
          <div className="p-4 text-sm text-muted-foreground">No video selected.</div>
        )}
      </SheetContent>
      {labelDialog && video && (
        <SpeakerLabelDialog
          open={true}
          onOpenChange={(o) => { if (!o) setLabelDialog(null); }}
          localSpeaker={labelDialog.localSpeaker}
          contextLabel={video.title}
          videoId={video.video_id}
          channelId={video.channel_id}
          currentSpeakerId={labelDialog.currentSpeakerId}
          onSaved={loadSpeakerMap}
        />
      )}
    </Sheet>
  );
}

interface ClipTimelineProps {
  duration: number;
  clips: RelatedClip[];
  currentSeconds: number;
  onSeek: (seconds: number, autoplay?: boolean) => void;
}

/**
 * A thin marker strip showing every saved clip in this video as a colored
 * region positioned by start/duration. Click a marker to seek to that
 * clip's start. Click empty space to scrub. The current playhead is drawn
 * as a vertical line.
 */
function ClipTimeline({ duration, clips, currentSeconds, onSeek }: ClipTimelineProps) {
  const handleStripClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(duration, fraction * duration)), false);
  };

  const playheadPercent = Math.max(0, Math.min(100, (currentSeconds / duration) * 100));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Clip timeline</span>
        <span>{clips.length} marker{clips.length === 1 ? "" : "s"}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={currentSeconds}
        aria-label="Click to scrub. Markers represent saved clips."
        onClick={handleStripClick}
        className="relative h-5 w-full cursor-pointer overflow-hidden rounded-md border bg-muted"
      >
        {clips.map(clip => {
          const left = Math.max(0, (clip.start_seconds / duration) * 100);
          const widthPct = Math.max(0.4, ((clip.end_seconds - clip.start_seconds) / duration) * 100);
          const tooltip = clip.note
            ? `${clip.quote.slice(0, 80)}\n— ${clip.note}`
            : clip.quote.slice(0, 120);
          return (
            <button
              key={clip.id}
              type="button"
              title={tooltip}
              onClick={event => {
                event.stopPropagation();
                onSeek(clip.start_seconds);
              }}
              style={{ left: `${left}%`, width: `${widthPct}%`, minWidth: 4 }}
              className="absolute top-0 h-full bg-primary/40 transition-colors hover:bg-primary/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={`Saved clip from ${formatTimestamp(clip.start_seconds)} to ${formatTimestamp(clip.end_seconds)}`}
            />
          );
        })}
        <div
          className="pointer-events-none absolute top-0 h-full w-px bg-foreground/80"
          style={{ left: `${playheadPercent}%` }}
        />
      </div>
    </div>
  );
}

interface RelatedClipSectionProps {
  heading: string;
  description: string | null;
  clips: RelatedClip[];
  loading: boolean;
  emptyMessage: string;
  showOverlap?: boolean;
  onSelect: (clip: RelatedClip) => void;
}

/**
 * AI-generated 2-3 sentence summary of the transcript. Lives in its own
 * `ai_summary` column, completely separate from user-authored `notes`.
 * Empty state nudges the user to either configure a chat model on the
 * AI page or run the bulk reindex; populated state shows the summary
 * with the model that wrote it and a regenerate button.
 */
function AiSummarySection({
  summary,
  model,
  regenerating,
  onRegenerate,
}: {
  summary: string;
  model: string | null;
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-primary/30 bg-primary/5 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          AI summary
        </div>
        <button
          type="button"
          onClick={onRegenerate}
          disabled={regenerating}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          title={summary ? "Regenerate with current chat model" : "Generate with current chat model"}
        >
          {regenerating
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <RefreshCw className="h-3 w-3" />}
          {summary ? "Regenerate" : "Generate"}
        </button>
      </div>
      {summary ? (
        <>
          <p className="text-sm leading-6 text-foreground">{summary}</p>
          {model && (
            <div className="text-[10px] text-muted-foreground font-mono">
              {model}
            </div>
          )}
        </>
      ) : (
        <p className="text-xs italic text-muted-foreground">
          No AI summary yet. Click Generate, or run the backfill on the AI page to do all transcripts at once.
        </p>
      )}
    </div>
  );
}

function RelatedClipSection({
  heading,
  description,
  clips,
  loading,
  emptyMessage,
  showOverlap,
  onSelect,
}: RelatedClipSectionProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-sm font-medium">{heading}</span>
          {description && (
            <span className="text-xs text-muted-foreground">{description}</span>
          )}
        </div>
        <Badge variant="outline">{clips.length}</Badge>
      </div>
      <div className="rounded-md border">
        {clips.map(clip => (
          <button
            key={clip.id}
            type="button"
            onClick={() => onSelect(clip)}
            className="block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent"
          >
            <span className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Play className="h-3 w-3" />
              {formatTimestamp(clip.start_seconds)} - {formatTimestamp(clip.end_seconds)}
              {showOverlap && clip.overlap !== undefined && (
                <Badge variant="secondary" className="h-5 text-[10px]">
                  {clip.overlap} tag match{clip.overlap === 1 ? "" : "es"}
                </Badge>
              )}
              <span className="ml-auto truncate">{clip.channel_name || clip.channel_id}</span>
            </span>
            {showOverlap && (
              <span className="mb-1 block truncate text-xs text-muted-foreground">{clip.title}</span>
            )}
            <span className="line-clamp-2 leading-6">{clip.quote}</span>
            {clip.note && <span className="mt-1 block text-xs text-muted-foreground">{clip.note}</span>}
            {clip.tags?.length > 0 && (
              <span className="mt-1.5 flex flex-wrap gap-1">
                {clip.tags.map(tag => (
                  <TagChip key={tag} tag={tag} variant="outline" />
                ))}
              </span>
            )}
          </button>
        ))}
        {loading && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
        {!loading && !clips.length && (
          <p className="p-3 text-sm text-muted-foreground">{emptyMessage}</p>
        )}
      </div>
    </div>
  );
}
