import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  AlertCircle,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileText,
  Loader2,
  Mic,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";

interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

interface QueueEntry {
  video_id: string;
  channel_id: string;
  title: string;
  url: string;
  duration: number | null;
  is_live: number;
  is_shorts: number;
  upload_date: string | null;
  status: string;
  video_path: string | null;
  md_path: string | null;
  word_count: number;
  error: string | null;
  retries: number;
  updated_at: string;
}

interface QueueResponse {
  counts: Record<string, number>;
  recent: QueueEntry[];
  total: number;
  limit: number;
  offset: number;
}

interface ConfigResponse {
  channels: Channel[];
  transcription?: { model?: string };
}

const LIBRARY_SETTINGS_KEY = "concord-library-settings-v1";
const LEGACY_LIBRARY_SETTINGS_KEY = "youtube-ripper-library-settings-v1";

interface LibrarySettings {
  model?: string;
  query?: string;
  status?: string;
  channelId?: string;
  type?: string;
  hasTranscript?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}

function loadLibrarySettings(): LibrarySettings {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(LIBRARY_SETTINGS_KEY)
      ?? window.localStorage.getItem(LEGACY_LIBRARY_SETTINGS_KEY);
    return JSON.parse(raw || "{}") as LibrarySettings;
  } catch {
    return {};
  }
}

function formatDate(uploadDate: string | null): string {
  if (!uploadDate) return "";
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }
  return uploadDate;
}

const AUDIO_EXTS = new Set([".mp3", ".m4a", ".wav", ".flac", ".aac", ".opus", ".ogg"]);

function isAudioPath(filePath?: string | null): boolean {
  if (!filePath) return false;
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot < 0) return false;
  return AUDIO_EXTS.has(filePath.slice(lastDot).toLowerCase());
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const safe = Math.floor(seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "complete") return "default";
  if (status === "failed") return "destructive";
  if (status === "pending") return "secondary";
  return "outline";
}

function statusBadge(status: string) {
  const map: Record<string, { v: "default" | "secondary" | "destructive" | "outline"; icon: any; label: string }> = {
    pending: { v: "secondary", icon: Clock, label: "Pending" },
    waiting_live: { v: "secondary", icon: Radio, label: "Live" },
    downloading: { v: "secondary", icon: Download, label: "Downloading" },
    extracting_audio: { v: "secondary", icon: Mic, label: "Extracting" },
    transcribing: { v: "secondary", icon: FileText, label: "Transcribing" },
    saving_md: { v: "secondary", icon: FileText, label: "Saving" },
    complete: { v: "default", icon: CheckCircle, label: "Done" },
    failed: { v: "destructive", icon: XCircle, label: "Failed" },
  };
  const statusConfig = map[status] || { v: "outline" as const, icon: AlertCircle, label: status };
  return (
    <Badge variant={statusConfig.v} className="gap-1 whitespace-nowrap">
      <statusConfig.icon className="h-3 w-3" />
      {statusConfig.label}
    </Badge>
  );
}

function modelSelector(value: string, onChange: (value: string) => void) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs w-[150px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="large-v3">large-v3</SelectItem>
        <SelectItem value="large-v3-turbo">turbo</SelectItem>
        <SelectItem value="medium">medium</SelectItem>
        <SelectItem value="small">small</SelectItem>
        <SelectItem value="tiny">tiny</SelectItem>
        <SelectItem value="nvidia/parakeet-tdt-0.6b-v3">parakeet-v3</SelectItem>
      </SelectContent>
    </Select>
  );
}

export default function Library() {
  const savedSettings = useMemo(() => loadLibrarySettings(), []);
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [channels, setChannels] = useState<Channel[]>([]);
  const [model, setModel] = useState(savedSettings.model || "large-v3");
  const [query, setQuery] = useState(savedSettings.query || "");
  const [status, setStatus] = useState(savedSettings.status || "all");
  const [channelId, setChannelId] = useState(savedSettings.channelId || "all");
  const [type, setType] = useState(savedSettings.type || "all");
  const [hasTranscript, setHasTranscript] = useState(savedSettings.hasTranscript || "all");
  const [sort, setSort] = useState(savedSettings.sort || "upload_desc");
  const [page, setPage] = useState(savedSettings.page || 0);
  const [pageSize, setPageSize] = useState(savedSettings.pageSize || 50);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [retranscribing, setRetranscribing] = useState<Record<string, boolean>>({});
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Per-video speaker badges. Refetched after entries load (one batch
  // request) and after the drawer closes (in case the user re-labeled
  // a speaker in the open video).
  const [speakerBadges, setSpeakerBadges] = useState<Record<string, { speaker_id: string; name: string; display_color: string | null; airtime_seconds: number; local_speaker: string }[]>>({});
  const { toast } = useToast();

  const channelNames = useMemo(() => {
    return Object.fromEntries(channels.map(ch => [ch.id, ch.name]));
  }, [channels]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const startRow = total === 0 ? 0 : page * pageSize + 1;
  const endRow = Math.min(total, page * pageSize + entries.length);

  useEffect(() => {
    setPage(0);
  }, [channelId, hasTranscript, pageSize, query, sort, status, type]);

  useEffect(() => {
    window.localStorage.setItem(LIBRARY_SETTINGS_KEY, JSON.stringify({
      model,
      query,
      status,
      channelId,
      type,
      hasTranscript,
      sort,
      page,
      pageSize,
    }));
  }, [channelId, hasTranscript, model, page, pageSize, query, sort, status, type]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
        status,
        channelId,
        type,
        hasTranscript,
        sort,
        q: query.trim(),
        t: String(Date.now()),
      });
      const [queueRes, configRes] = await Promise.all([
        apiRequest("GET", `/api/pipeline/queue?${params.toString()}`),
        apiRequest("GET", `/api/pipeline/config?t=${Date.now()}`),
      ]);
      const queue = await queueRes.json() as QueueResponse;
      const config = await configRes.json() as ConfigResponse;
      setEntries(queue.recent || []);
      setCounts(queue.counts || {});
      setTotal(queue.total || 0);
      setChannels(config.channels || []);
      setModel(current => current || config.transcription?.model || "large-v3");
      // Best-effort batched speaker fetch — silently noop if the speakers
      // tables don't exist yet or the call fails. Doesn't block the page.
      const visible = (queue.recent || []).map(e => ({ videoId: e.video_id, channelId: e.channel_id }));
      if (visible.length > 0) {
        apiRequest("POST", "/api/videos/library/speakers-batch", { videos: visible })
          .then(r => r.json())
          .then(data => setSpeakerBadges(data.speakers || {}))
          .catch(() => setSpeakerBadges({}));
      } else {
        setSpeakerBadges({});
      }
    } catch (error: any) {
      toast({ variant: "destructive", title: "Library load failed", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [page, pageSize, status, channelId, type, hasTranscript, sort, query]);

  const retranscribe = async (entry: QueueEntry) => {
    const key = `${entry.channel_id}:${entry.video_id}`;
    setRetranscribing(prev => ({ ...prev, [key]: true }));
    try {
      await apiRequest("POST", "/api/pipeline/retranscribe", {
        videoId: entry.video_id,
        channelId: entry.channel_id,
        model,
      });
      toast({ title: "Re-transcription started", description: entry.title });
      fetchData();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Re-transcribe failed", description: error.message });
    } finally {
      setRetranscribing(prev => ({ ...prev, [key]: false }));
    }
  };

  const openDrawer = (entry: QueueEntry) => {
    setDrawerVideo({
      video_id: entry.video_id,
      channel_id: entry.channel_id,
      channel_name: channelNames[entry.channel_id] || entry.channel_id,
      title: entry.title,
      upload_date: entry.upload_date,
      duration: entry.duration,
      status: entry.status,
      is_live: entry.is_live,
      video_path: entry.video_path,
      md_path: entry.md_path,
      word_count: entry.word_count,
    });
    setDrawerSeconds(0);
    setDrawerOpen(true);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              Transcription Library
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search title, channel, path"
                  className="h-9 pl-8 w-full sm:w-72"
                />
              </div>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="h-9 w-[170px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  {channels.map(ch => <SelectItem key={ch.id} value={ch.id}>{ch.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-9 w-[145px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="waiting_live">Live wait</SelectItem>
                  <SelectItem value="downloading">Downloading</SelectItem>
                  <SelectItem value="transcribing">Transcribing</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="h-9 w-[120px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  <SelectItem value="video">Videos</SelectItem>
                  <SelectItem value="live">Lives</SelectItem>
                </SelectContent>
              </Select>
              <Select value={hasTranscript} onValueChange={setHasTranscript}>
                <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any transcript</SelectItem>
                  <SelectItem value="yes">Has transcript</SelectItem>
                  <SelectItem value="no">No transcript</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={setSort}>
                <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="upload_desc">Newest upload</SelectItem>
                  <SelectItem value="upload_asc">Oldest upload</SelectItem>
                  <SelectItem value="updated_desc">Recently updated</SelectItem>
                  <SelectItem value="words_desc">Most words</SelectItem>
                  <SelectItem value="title">Title</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={fetchData} disabled={loading} className="h-9">
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{total} matching</Badge>
            <Badge variant="outline">{entries.length} loaded</Badge>
            {Object.entries(counts).map(([key, value]) => (
              <Badge key={key} variant={statusVariant(key)}>{key}: {value}</Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              Showing {startRow}-{endRow} of {total} matching records.
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Page {Math.min(page + 1, pageCount)} of {pageCount}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0 || loading}
                onClick={() => setPage(value => Math.max(0, value - 1))}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page + 1 >= pageCount || loading}
                onClick={() => setPage(value => value + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
              <span className="text-xs text-muted-foreground">Rows</span>
              <Select value={String(pageSize)} onValueChange={value => setPageSize(Number(value))}>
                <SelectTrigger className="h-8 text-xs w-[90px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="50">50</SelectItem>
                  <SelectItem value="100">100</SelectItem>
                  <SelectItem value="250">250</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground">Model</span>
              {modelSelector(model, setModel)}
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[110px]">Upload</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="w-[150px]">Channel</TableHead>
                  <TableHead className="w-[120px]">Status</TableHead>
                  <TableHead className="w-[95px]">Words</TableHead>
                  <TableHead className="w-[120px]">Files</TableHead>
                  <TableHead className="w-[330px] text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(entry => {
                  const key = `${entry.channel_id}:${entry.video_id}`;
                  const canRetranscribe = !!entry.video_path && entry.status !== "downloading" && entry.status !== "transcribing";
                  return (
                    <TableRow key={key}>
                      <TableCell className="py-2 text-xs text-muted-foreground whitespace-nowrap">
                        {formatDate(entry.upload_date) || "No date"}
                        {entry.duration ? <div>{formatDuration(entry.duration)}</div> : null}
                      </TableCell>
                      <TableCell className="py-2 min-w-[280px]">
                        <div className="font-medium line-clamp-2">{entry.title}</div>
                        <div className="text-xs text-muted-foreground font-mono mt-1">{entry.video_id}</div>
                        {(speakerBadges[`${entry.video_id}|${entry.channel_id}`] || []).slice(0, 3).length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {speakerBadges[`${entry.video_id}|${entry.channel_id}`].slice(0, 3).map(s => (
                              <span
                                key={s.speaker_id}
                                className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
                                style={s.display_color
                                  ? { background: s.display_color, color: "white" }
                                  : { background: "var(--secondary, #e5e7eb)" }}
                                title={`${s.name} • ${Math.round(s.airtime_seconds)}s`}
                              >
                                {s.name}
                              </span>
                            ))}
                            {(speakerBadges[`${entry.video_id}|${entry.channel_id}`].length > 3) && (
                              <span className="text-[10px] text-muted-foreground self-center">
                                +{speakerBadges[`${entry.video_id}|${entry.channel_id}`].length - 3} more
                              </span>
                            )}
                          </div>
                        )}
                        {entry.error && <div className="text-xs text-destructive mt-1 line-clamp-2">{entry.error}</div>}
                      </TableCell>
                      <TableCell className="py-2 text-sm">
                        <div className="truncate max-w-[140px]">{channelNames[entry.channel_id] || entry.channel_id}</div>
                        {!!entry.is_live && <Badge variant="outline" className="mt-1 gap-1"><Radio className="h-3 w-3" />Live</Badge>}
                      </TableCell>
                      <TableCell className="py-2">{statusBadge(entry.status)}</TableCell>
                      <TableCell className="py-2 text-sm">{entry.word_count || ""}</TableCell>
                      <TableCell className="py-2">
                        <div className="flex flex-wrap gap-1">
                          {entry.video_path && (
                            <Badge variant="outline" className="gap-1">
                              {isAudioPath(entry.video_path)
                                ? <><Mic className="h-3 w-3" />audio</>
                                : <>video</>}
                            </Badge>
                          )}
                          {entry.md_path && <Badge variant="outline">md</Badge>}
                          {!entry.video_path && !entry.md_path && <span className="text-xs text-muted-foreground">none</span>}
                        </div>
                      </TableCell>
                      <TableCell className="py-2">
                        <div className="flex justify-end gap-2">
                          {modelSelector(model, setModel)}
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 text-xs whitespace-nowrap"
                            disabled={!entry.video_path}
                            onClick={() => openDrawer(entry)}
                          >
                            <Play className="h-3 w-3" />
                            <span className="ml-1">Open</span>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-xs whitespace-nowrap"
                            disabled={!canRetranscribe || retranscribing[key]}
                            onClick={() => retranscribe(entry)}
                          >
                            {retranscribing[key]
                              ? <Loader2 className="h-3 w-3 animate-spin" />
                              : <RotateCcw className="h-3 w-3" />}
                            <span className="ml-1">Re-transcribe</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!entries.length && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                      No videos match these filters.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-muted-foreground">
              Page {Math.min(page + 1, pageCount)} of {pageCount}
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0 || loading}
                onClick={() => setPage(value => Math.max(0, value - 1))}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page + 1 >= pageCount || loading}
                onClick={() => setPage(value => value + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
      <VideoDrawer
        open={drawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
        onOpenChange={setDrawerOpen}
      />
    </div>
  );
}
