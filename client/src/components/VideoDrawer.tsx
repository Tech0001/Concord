import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { TagChip, TagPicker } from "@/components/TagPicker";
import { apiRequest } from "@/lib/queryClient";
import { BookmarkPlus, Calendar, ChevronDown, ChevronUp, Clock, FileText, Play, Radio, Search, X } from "lucide-react";
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

function videoKey(video: VideoDrawerEntry | null): string {
  return video ? `${video.channel_id}:${video.video_id}` : "";
}

export function VideoDrawer({ open, video, initialSeconds = 0, initialSegmentIndex, onOpenChange }: VideoDrawerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const segmentRefs = useRef<Record<number, HTMLButtonElement | null>>({});
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
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
  const [notesStatus, setNotesStatus] = useState<"idle" | "saving" | "saved">("idle");
  const notesTimerRef = useRef<number | null>(null);
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
  }, [initialSeconds, initialSegmentIndex, videoKey(video)]);

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
        const data = await response.json() as { segments?: TranscriptSegment[]; notes?: string };
        setSegments(data.segments || []);
        setNotes(data.notes || "");
        setNotesStatus("idle");
      } catch (error: any) {
        setSegments([]);
        setSegmentError(error.message || "Could not load transcript timestamps");
      } finally {
        setLoadingSegments(false);
      }
    };

    loadSegments();
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
    if (activeSeconds > 0) seekTo(activeSeconds, false);
  };

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

  useEffect(() => {
    if (!open || highlightedSegmentIndex < 0 || loadingSegments) return;
    window.setTimeout(() => {
      segmentRefs.current[highlightedSegmentIndex]?.scrollIntoView({
        block: "center",
        behavior: "smooth",
      });
    }, 100);
  }, [open, highlightedSegmentIndex, loadingSegments]);

  const jumpSearch = (direction: 1 | -1) => {
    if (!transcriptMatches.length) return;
    const next = (searchCursor + direction + transcriptMatches.length) % transcriptMatches.length;
    setSearchCursor(next);
    const segment = segments[transcriptMatches[next]];
    if (segment) seekTo(segment.start, false);
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
      window.setTimeout(() => {
        segmentRefs.current[targetIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 100);
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

              <div className="flex flex-wrap gap-2">
                {video.status && <Badge variant="outline">{video.status}</Badge>}
                {!!video.word_count && <Badge variant="outline">{video.word_count} words</Badge>}
                {video.video_path && <Badge variant="outline">video</Badge>}
                {video.md_path && <Badge variant="outline">transcript</Badge>}
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <label htmlFor="video-notes" className="text-sm font-medium">Notes</label>
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
                  className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
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
                      />
                    </div>
                  )}
                </div>

                <div className="max-h-[48vh] overflow-y-auto rounded-md border">
                  {segments.map((segment, index) => {
                    const active = index === closestSegmentIndex;
                    const highlighted = index === highlightedSegmentIndex;
                    const searchMatch = transcriptMatches.includes(index);
                    const selected = !!rangeBounds && index >= rangeBounds.start && index <= rangeBounds.end;
                    const takingNote = clipSegmentIndex === index;
                    const clipped = isSegmentClipped(segment);
                    return (
                      <div
                        key={`${segment.start}:${index}`}
                        className={`border-b px-3 py-2 text-sm last:border-b-0 ${
                          clipped ? "border-l-2 border-l-primary/60" : ""
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
                            {highlighted && <Badge variant="secondary" className="h-5">match</Badge>}
                            {searchMatch && <Badge variant="outline" className="h-5">search</Badge>}
                            {clipped && <Badge variant="outline" className="h-5">clipped</Badge>}
                          </span>
                          <span className="leading-6">{segment.text}</span>
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
    </Sheet>
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
