import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { apiRequest } from "@/lib/queryClient";
import { Calendar, Clock, FileText, Play, Radio } from "lucide-react";

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

interface VideoDrawerProps {
  open: boolean;
  video: VideoDrawerEntry | null;
  initialSeconds?: number;
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

export function VideoDrawer({ open, video, initialSeconds = 0, onOpenChange }: VideoDrawerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [loadingSegments, setLoadingSegments] = useState(false);
  const [segmentError, setSegmentError] = useState("");
  const [activeSeconds, setActiveSeconds] = useState(initialSeconds);

  const streamUrl = useMemo(() => {
    if (!video?.video_path) return "";
    return `/api/videos/library/${encodeURIComponent(video.channel_id)}/${encodeURIComponent(video.video_id)}/stream`;
  }, [video]);

  useEffect(() => {
    setActiveSeconds(initialSeconds);
  }, [initialSeconds, videoKey(video)]);

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
        const data = await response.json() as { segments?: TranscriptSegment[] };
        setSegments(data.segments || []);
      } catch (error: any) {
        setSegments([]);
        setSegmentError(error.message || "Could not load transcript timestamps");
      } finally {
        setLoadingSegments(false);
      }
    };

    loadSegments();
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

                <div className="max-h-[48vh] overflow-y-auto rounded-md border">
                  {segments.map((segment, index) => {
                    const active = index === closestSegmentIndex;
                    return (
                      <button
                        key={`${segment.start}:${index}`}
                        type="button"
                        onClick={() => seekTo(segment.start)}
                        className={`block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent ${
                          active ? "bg-accent" : ""
                        }`}
                      >
                        <span className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                          <Play className="h-3 w-3" />
                          {formatTimestamp(segment.start)} - {formatTimestamp(segment.end)}
                        </span>
                        <span className="leading-6">{segment.text}</span>
                      </button>
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
