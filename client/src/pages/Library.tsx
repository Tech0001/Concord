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
import { visibleModels, defaultModelForPlatform } from "@/lib/transcription-models";
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Database,
  Download,
  FileText,
  Filter,
  Loader2,
  Mic,
  MoreVertical,
  Pencil,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import * as DialogPrimitive from "@radix-ui/react-dialog";

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
  transcription?: { model?: string; engine?: "" | "parakeet" | "whisper" };
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

function modelSelector(
  platform: NodeJS.Platform | null,
  value: string,
  onChange: (value: string) => void,
  installedEngine: "" | "parakeet" | "whisper" | null | undefined,
) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-xs w-[150px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {visibleModels(platform, value, installedEngine || null).map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export default function Library() {
  const savedSettings = useMemo(() => loadLibrarySettings(), []);
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [channels, setChannels] = useState<Channel[]>([]);
  const [installedEngine, setInstalledEngine] = useState<"" | "parakeet" | "whisper">("");
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
  // Rename dialog state. `target` carries the entry whose file we're
  // about to rename; null when the dialog is closed.
  const [renameTarget, setRenameTarget] = useState<QueueEntry | null>(null);
  // Same shape for the trash confirm dialog.
  const [trashTarget, setTrashTarget] = useState<QueueEntry | null>(null);
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Per-video speaker badges. Refetched after entries load (one batch
  // request) and after the drawer closes (in case the user re-labeled
  // a speaker in the open video).
  const [speakerBadges, setSpeakerBadges] = useState<Record<string, { speaker_id: string; name: string; display_color: string | null; airtime_seconds: number; local_speaker: string }[]>>({});
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    apiRequest("GET", "/api/system/info")
      .then((r) => r.json())
      .then((d: { platform: NodeJS.Platform }) => {
        setPlatform(d.platform);
        // Migrate users who never saved a preference off the legacy "large-v3"
        // default onto whatever actually runs on their machine (FluidAudio on
        // Mac, whisper-large on Linux). Skip if they explicitly picked something.
        if (!savedSettings.model) {
          setModel(defaultModelForPlatform(d.platform));
        }
      })
      .catch(() => { /* leave null — selector shows all */ });
  }, []);

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
      setInstalledEngine(config.transcription?.engine || "");
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

  // While any entry on this page is queued / extracting / transcribing,
  // re-poll the queue every 4s so the spinner buttons reflect the live
  // state. Idle when nothing's in flight (no wasted polls during normal
  // browsing).
  const hasInFlight = entries.some(
    e => e.status === "queued" || e.status === "transcribing" || e.status === "extracting_audio",
  );
  useEffect(() => {
    if (!hasInFlight) return;
    const id = window.setInterval(() => { fetchData(); }, 4000);
    return () => window.clearInterval(id);
    // fetchData is stable enough — we explicitly want the interval to
    // restart only when in-flight state toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasInFlight]);

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
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <Database className="h-4 w-4" />
              Library
            </CardTitle>
            <div className="text-xs text-muted-foreground" title={Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join("  ·  ")}>
              {total.toLocaleString()} {total === 1 ? "video" : "videos"}
              {counts.complete !== undefined && <> · <span className="text-foreground">{(counts.complete || 0).toLocaleString()}</span> complete</>}
              {(counts.failed ?? 0) > 0 && <> · <span className="text-amber-600 dark:text-amber-400">{counts.failed} failed</span></>}
              {(counts.pending ?? 0) > 0 && <> · {counts.pending} pending</>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[260px]">
              <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search title, channel, path"
                className="h-9 pl-8"
              />
            </div>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger className="h-9 w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                {channels.map(ch => <SelectItem key={ch.id} value={ch.id}>{ch.name}</SelectItem>)}
              </SelectContent>
            </Select>

            {(() => {
              const activeFilterCount =
                (status !== "all" ? 1 : 0) +
                (type !== "all" ? 1 : 0) +
                (hasTranscript !== "all" ? 1 : 0) +
                (sort !== "upload_desc" ? 1 : 0);
              return (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className="h-9">
                      <Filter className="h-3.5 w-3.5" />
                      Filters
                      {activeFilterCount > 0 && (
                        <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">{activeFilterCount}</Badge>
                      )}
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 space-y-2 p-3" align="end">
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</label>
                      <Select value={status} onValueChange={setStatus}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
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
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Type</label>
                      <Select value={type} onValueChange={setType}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All types</SelectItem>
                          <SelectItem value="video">Videos</SelectItem>
                          <SelectItem value="live">Lives</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Transcript</label>
                      <Select value={hasTranscript} onValueChange={setHasTranscript}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Any transcript</SelectItem>
                          <SelectItem value="yes">Has transcript</SelectItem>
                          <SelectItem value="no">No transcript</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Sort</label>
                      <Select value={sort} onValueChange={setSort}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="upload_desc">Newest upload</SelectItem>
                          <SelectItem value="upload_asc">Oldest upload</SelectItem>
                          <SelectItem value="updated_desc">Recently updated</SelectItem>
                          <SelectItem value="words_desc">Most words</SelectItem>
                          <SelectItem value="title">Title</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {activeFilterCount > 0 && (
                      <div className="flex justify-end pt-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => {
                            setStatus("all"); setType("all"); setHasTranscript("all"); setSort("upload_desc");
                          }}
                        >
                          Reset
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              );
            })()}

            <Button size="sm" variant="outline" onClick={fetchData} disabled={loading} className="h-9">
              <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Compact status line + per-page model selector. Pagination
              proper lives below the table (single bar instead of two). */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">
              Showing <span className="text-foreground font-mono">{startRow}–{endRow}</span> of <span className="text-foreground font-mono">{total.toLocaleString()}</span>
            </span>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Re-transcribe model</span>
              {modelSelector(platform, model, setModel, installedEngine)}
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
                  <TableHead className="w-[200px] text-right">Actions</TableHead>
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
                          {(() => {
                            // The button reflects an active retranscribe via
                            // either of two signals so the spinner stays up
                            // for the entire job (not just the click→enqueue
                            // millisecond):
                            //   • retranscribing[key] — local "I just clicked"
                            //     latch, true until fetchData replies.
                            //   • entry.status — server-side queue state. A
                            //     retranscribe sets it to "queued" then
                            //     "transcribing"; revert (or "complete") on done.
                            const inFlight = retranscribing[key]
                              || entry.status === "queued"
                              || entry.status === "transcribing"
                              || entry.status === "extracting_audio";
                            return (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 text-xs whitespace-nowrap"
                                disabled={!canRetranscribe || inFlight}
                                onClick={() => retranscribe(entry)}
                                title={inFlight ? `Re-transcribing (${entry.status})` : `Re-transcribe with: ${model}`}
                              >
                                {inFlight
                                  ? <Loader2 className="h-3 w-3 animate-spin" />
                                  : <RotateCcw className="h-3 w-3" />}
                                <span className="ml-1">{inFlight ? entry.status === "queued" ? "Queued" : "Transcribing" : "Re-transcribe"}</span>
                              </Button>
                            );
                          })()}

                          {/* Row overflow menu — currently just Rename;
                              Move-to-Trash will land here once wired. */}
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                disabled={!entry.video_path}
                                title="More actions"
                              >
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent className="w-48 p-1" align="end">
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
                                disabled={!entry.video_path}
                                onClick={() => setRenameTarget(entry)}
                              >
                                <Pencil className="h-3 w-3" />
                                Rename file
                              </button>
                              <button
                                type="button"
                                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-red-600 hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-400"
                                disabled={!entry.video_path}
                                onClick={() => setTrashTarget(entry)}
                              >
                                <Trash2 className="h-3 w-3" />
                                Move to trash…
                              </button>
                            </PopoverContent>
                          </Popover>
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
              <Select value={String(pageSize)} onValueChange={value => setPageSize(Number(value))}>
                <SelectTrigger className="h-8 w-[100px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="50">50 / page</SelectItem>
                  <SelectItem value="100">100 / page</SelectItem>
                  <SelectItem value="250">250 / page</SelectItem>
                </SelectContent>
              </Select>
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
      {renameTarget && (
        <RenameFileDialog
          entry={renameTarget}
          onClose={() => setRenameTarget(null)}
          onSaved={() => { setRenameTarget(null); fetchData(); }}
        />
      )}
      {trashTarget && (
        <TrashFileDialog
          entry={trashTarget}
          onClose={() => setTrashTarget(null)}
          onTrashed={() => { setTrashTarget(null); fetchData(); }}
        />
      )}
    </div>
  );
}

interface RenameFileDialogProps {
  entry: QueueEntry;
  onClose: () => void;
  onSaved: () => void;
}

/** Modal for renaming a video file. Lets the user edit the basename
 *  (no path, no extension) and validates the same constraints the
 *  server applies so the user gets fast feedback. On save the server
 *  also renames the matching transcript MD and any .playback.m4a
 *  sidecar so all related paths stay aligned with the DB. */
function RenameFileDialog({ entry, onClose, onSaved }: RenameFileDialogProps) {
  const { toast } = useToast();
  const currentBasename = useMemo(() => {
    if (!entry.video_path) return "";
    const base = entry.video_path.split(/[\\/]/).pop() || "";
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
  }, [entry.video_path]);
  const [name, setName] = useState(currentBasename);
  const [busy, setBusy] = useState(false);

  // Mirror the server-side validation rules so the Save button is
  // greyed out before the user even tries to submit a bad name.
  const validation = useMemo(() => {
    const trimmed = name.trim();
    if (!trimmed) return "Name cannot be empty";
    if (trimmed.length > 200) return "Name too long (max 200 chars)";
    if (/[\\/]/.test(trimmed)) return "Name may not contain / or \\";
    if (trimmed.startsWith(".")) return "Name may not start with .";
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(trimmed)) return "Name contains control characters";
    if (trimmed === currentBasename) return "Name is unchanged";
    return null;
  }, [name, currentBasename]);

  const submit = async () => {
    if (validation || busy) return;
    setBusy(true);
    try {
      await apiRequest("POST", `/api/videos/library/${encodeURIComponent(entry.channel_id)}/${encodeURIComponent(entry.video_id)}/rename`, {
        newBasename: name.trim(),
      });
      toast({ title: "File renamed", description: name.trim() });
      onSaved();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Rename failed", description: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[101] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-0 shadow-lg mx-4">
          <div className="flex items-center justify-between gap-2 border-b p-4">
            <DialogPrimitive.Title className="text-base font-semibold">Rename file</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="space-y-3 p-4 text-xs">
            <DialogPrimitive.Description className="text-muted-foreground">
              Renames the video file, transcript markdown, and playback sidecar (if present) together. The DB stays linked.
            </DialogPrimitive.Description>
            <div>
              <div className="mb-1 text-muted-foreground">Current name</div>
              <code className="block break-all rounded bg-muted px-2 py-1 font-mono text-foreground">{currentBasename}</code>
            </div>
            <div>
              <label htmlFor="rename-input" className="mb-1 block text-muted-foreground">New name (no path, no extension)</label>
              <Input
                id="rename-input"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
                className="font-mono"
              />
              {validation && <p className="mt-1 text-red-600 dark:text-red-400">{validation}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button size="sm" onClick={submit} disabled={!!validation || busy}>
                {busy ? "Renaming…" : "Rename"}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

interface TrashFileDialogProps {
  entry: QueueEntry;
  onClose: () => void;
  onTrashed: () => void;
}

/** Soft-delete confirmation: moves the video + transcript MD + .playback
 *  sidecar to the OS Trash. The DB row stays (status becomes "archived",
 *  the file path columns get nulled) so notes / clips / embeddings the
 *  user already created remain linked to the same video_id. The user can
 *  always restore from Trash if they change their mind. */
function TrashFileDialog({ entry, onClose, onTrashed }: TrashFileDialogProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await apiRequest("POST", `/api/videos/library/${encodeURIComponent(entry.channel_id)}/${encodeURIComponent(entry.video_id)}/trash`, {});
      const data = await r.json() as { trashed?: string[]; failed?: { path: string; error: string }[] };
      const trashed = data.trashed?.length ?? 0;
      const failed = data.failed?.length ?? 0;
      toast({
        title: "Moved to trash",
        description: `${trashed} file${trashed === 1 ? "" : "s"} trashed${failed ? `, ${failed} failed (see console)` : ""}`,
      });
      if (data.failed && data.failed.length > 0) {
        // Surface failures for the rare case where the sidecar didn't
        // make it but the main video did.
        for (const f of data.failed) console.error(`[trash] failed: ${f.path}: ${f.error}`);
      }
      onTrashed();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Trash failed", description: err?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-[101] w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-card p-0 shadow-lg mx-4">
          <div className="flex items-center justify-between gap-2 border-b p-4">
            <DialogPrimitive.Title className="text-base font-semibold">Move to trash?</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label="Close">
                <X className="h-4 w-4" />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="space-y-3 p-4 text-xs">
            <DialogPrimitive.Description className="text-muted-foreground">
              Moves the video file, transcript markdown, and playback sidecar (if present) to your OS trash. They can be restored from your file manager's Trash.
            </DialogPrimitive.Description>
            <div className="rounded-md border bg-muted/30 p-2">
              <div className="line-clamp-2 font-medium text-foreground">{entry.title}</div>
              <code className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{entry.video_path}</code>
            </div>
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-amber-900 dark:text-amber-200">
              The library entry is removed from the Library after a successful trash. Any clips you made keep their text but no longer link back to the original.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
              <Button size="sm" variant="destructive" onClick={submit} disabled={busy}>
                <Trash2 className="mr-1.5 h-3 w-3" />
                {busy ? "Trashing…" : "Move to trash"}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
