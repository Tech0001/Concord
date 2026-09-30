import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import UrlInput from "@/components/UrlInput";
import VideoPreview from "@/components/VideoPreview";
import ErrorMessage from "@/components/ErrorMessage";
import LoadingIndicator from "@/components/LoadingIndicator";
import { VideoInfo } from "@/types/video";
import {
  Plus, Trash2, Activity,
  CheckCircle, XCircle, Clock, AlertCircle, Radio,
  FileText, Download, Mic, FileDown, Loader2, Archive, List,
  RotateCcw, ChevronDown, FileAudio, FolderOpen, Globe, Pencil
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { visibleModels, compatibleModelSelection } from "@/lib/transcription-models";
import FolderInput from "@/components/FolderInput";
import { useCategory } from "@/hooks/use-category";

interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** Run speaker diarization for this channel. Undefined treated as true
   *  (legacy channels created before the toggle existed default-on). */
  diarize?: boolean;
  /** Include YouTube Shorts when scanning this channel. Off by default. */
  include_shorts?: boolean;
  /** Personal / work category. Drives the header viewing toggle. */
  category?: "personal" | "work";
}

interface Job {
  id: string;
  channelId: string;
  channelName: string;
  videoId: string;
  videoTitle: string;
  videoUrl: string;
  status: string;
  progress: number;
  error?: string;
  startedAt: string;
  completedAt?: string;
  videoPath?: string;
  audioPath?: string;
  mdPath?: string;
  transcriptionResult?: any;
  model?: string;
  retries: number;
}

interface PipelineState {
  status: string;
  lastCheck: string | null;
  nextCheck: string | null;
  totalCompleted: number;
  pendingCount: number;
  jobs: Job[];
  monitoredChannels: Channel[];
  dailyDownloadCount?: number;
  dailyDownloadCap?: number;
}

interface Config {
  channels: Channel[];
  workingDir: string;
  videoSaveDir: string;
  transcriptDir: string;
  qmdVaultDir: string | null;
  checkIntervalMinutes: number;
  skipShorts: boolean;
  videoQuality: string;
  videoCodec: string;
  audioLanguage: string;
  youtubeCookiesFromBrowser: string;
  youtubeCookiesFile: string;
  youtubeSpeedPreset: "fast" | "balanced" | "conservative";
  dailyDownloadCap: number;
  lanAccess: boolean;
  transcription: { model: string; language: string; device: string; engine?: "" | "nemo" | "parakeet" | "whisper" };
  processing: { keepVideo: boolean; keepAudio: boolean; waitForLiveToFinish: boolean; diarizationEnabled: boolean };
}

function transcribingLabel(model: string | undefined, device = "cuda"): string {
  if (!model) return "Transcribing…";
  const m = model.toLowerCase();
  if (m.includes("nemotron")) return `Transcribing with Nemotron 3.5 (${device === "cpu" ? "CPU" : "native acceleration"})…`;
  // Check fluid- prefix BEFORE the parakeet substring match — the Mac
  // engine is "fluid-parakeet-tdt-v3", which contains "parakeet" but runs
  // through FluidAudio on the Apple Neural Engine, not NeMo on CUDA.
  if (m.startsWith("fluid-") || m.includes("fluidaudio")) {
    return "Transcribing with FluidAudio on Apple Neural Engine…";
  }
  if (m.includes("parakeet")) {
    return `Transcribing with Parakeet (${model.split("/").pop()}) on ${device === "cpu" ? "CPU" : "NVIDIA GPU"}…`;
  }
  return `Transcribing with faster-whisper (${model}) on ${device === "cpu" ? "CPU" : "NVIDIA GPU"}…`;
}

interface QueueData {
  counts: Record<string, number>;
  recent: any[];
}

export default function PipelineStatus() {
  const [state, setState] = useState<PipelineState | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelUrl, setNewChannelUrl] = useState("");
  const [newChannelKind, setNewChannelKind] = useState<"youtube" | "folder">("youtube");
  const [newChannelCategory, setNewChannelCategory] = useState<"personal" | "work">("personal");
  const [archiving, setArchiving] = useState<Record<string, boolean>>({});
  const [retransModel, setRetransModel] = useState("");
  const [retranscribing, setRetranscribing] = useState<Record<string, boolean>>({});
  const [archiveMsg, setArchiveMsg] = useState<Record<string, string>>({});
  // "Virtual" channels — distinct channel_id strings in video_queue that
  // never made it into the configured channels list. Surfaces one-off
  // manual downloads so Rename / Import-folder actions reach them too.
  const [virtualChannels, setVirtualChannels] = useState<{ channelId: string; videoCount: number }[]>([]);
  // Configuration is edited in the Pipeline workspace Setup view.
  const [ytdlpHealth, setYtdlpHealth] = useState<{ ok: boolean; version: string | null; kind: "user" | "bundled" | "native" | "zipapp"; path: string; updatable?: boolean; error?: string } | null>(null);
  const [ytdlpHealthChecking, setYtdlpHealthChecking] = useState(false);
  const [ytdlpUpdating, setYtdlpUpdating] = useState(false);

  // Download state (same pattern as main page)
  const [videoData, setVideoData] = useState<VideoInfo | null>(null);
  const [isVideoLoading, setIsVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [isDownloading, setIsDownloading] = useState(false);
  // videoId currently being transcribed via the manual flow. Lets us pull
  // the matching job from state.jobs and render its progress inside VideoPreview
  // instead of forcing the user to scroll to the global job list.
  const [manualTranscribeId, setManualTranscribeId] = useState<string | null>(null);
  const { toast } = useToast();
  const { category: headerCategory, serverCategory } = useCategory();

  // Seed the new-channel category from the header toggle so the
  // common case ("I'm viewing work, add a work channel") needs zero
  // clicks. Falls back to 'personal' when the toggle is 'both'.
  useEffect(() => {
    setNewChannelCategory(headerCategory === "work" ? "work" : "personal");
  }, [headerCategory]);

  const fetchYtdlpHealth = async (force = false) => {
    setYtdlpHealthChecking(true);
    try {
      const r = await apiRequest("GET", `/api/pipeline/ytdlp-health${force ? "?force=1" : ""}`);
      setYtdlpHealth(await r.json());
    } catch {
      setYtdlpHealth({ ok: false, version: null, kind: "bundled", path: "", error: "Probe failed" });
    } finally {
      setYtdlpHealthChecking(false);
    }
  };

  const updateYtdlp = async () => {
    if (ytdlpUpdating) return;
    setYtdlpUpdating(true);
    try {
      const r = await apiRequest("POST", "/api/pipeline/ytdlp-update", {});
      const data = await r.json() as { fromVersion?: string | null; toVersion?: string; error?: string };
      if (data.error) throw new Error(data.error);
      toast({
        title: "yt-dlp updated",
        description: `${data.fromVersion ?? "(none)"} → ${data.toVersion ?? "?"}`,
      });
      await fetchYtdlpHealth(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "yt-dlp update failed",
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setYtdlpUpdating(false);
    }
  };

  useEffect(() => {
    fetchState();
    fetchConfig();
    fetchVirtualChannels();
    fetchYtdlpHealth();
    apiRequest("GET", "/api/system/info")
      .then((r) => r.json())
      .then((d: { platform: NodeJS.Platform }) => setPlatform(d.platform))
      .catch(() => { /* leave null — dropdown shows all */ });

    const es = new EventSource("/api/pipeline/events");
    es.addEventListener("state", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (d && Array.isArray(d.jobs)) {
          setState(d);
        } else {
          fetchState();
          fetchConfig();
        }
      } catch {}
    });
    es.addEventListener("job", (e) => {
      try {
        const job = JSON.parse(e.data);
        setState(prev => {
          if (!prev) return { jobs: [job] } as any;
          const jobs = [...(prev.jobs || [])];
          const idx = jobs.findIndex(j => j.id === job.id);
          if (idx >= 0) jobs[idx] = job; else jobs.unshift(job);
          return { ...prev, jobs };
        });
      } catch {}
    });
    return () => es.close();
  }, []);

  const fetchState = async () => {
    try { const r = await apiRequest("GET", "/api/pipeline/status"); setState(await r.json()); } catch {}
  };

  const fetchConfig = async () => {
    try {
      const r = await apiRequest("GET", "/api/pipeline/config");
      const loaded = await r.json() as Config;
      setConfig(loaded);
      setRetransModel(current => compatibleModelSelection(current, loaded.transcription.model));
    } catch {}
  };

  const fetchVirtualChannels = async () => {
    try {
      const r = await apiRequest("GET", `/api/pipeline/channels/virtual?t=${Date.now()}`);
      const data = await r.json() as { channels: { channelId: string; videoCount: number }[] };
      setVirtualChannels(data.channels || []);
    } catch { setVirtualChannels([]); }
  };

  /** Rename a virtual channel — UPDATEs every video_queue row with the
   *  old channel_id. Used to fix UC... → "Rick Joyner" after a manual
   *  download captured the wrong identifier. */
  const renameVirtualChannel = async (channelId: string) => {
    const next = window.prompt(`Rename "${channelId}" to:`, channelId);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === channelId) return;
    try {
      const r = await apiRequest("PATCH", `/api/pipeline/channels/virtual/${encodeURIComponent(channelId)}`, { name: trimmed });
      const data = await r.json() as { updated: number };
      toast({ title: "Channel renamed", description: `${data.updated} row${data.updated === 1 ? "" : "s"} updated → ${trimmed}` });
      fetchVirtualChannels();
      fetchState();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Rename failed", description: e.message });
    }
  };

  /** Same import-folder endpoint as configured channels — the backend
   *  falls back to using the channel_id string as the folder name when
   *  there's no channels-table row. */
  const importVirtualFolder = async (channelId: string) => {
    if (!confirm(`Scan "${channelId}"'s folder for additional local files? Files already tracked are skipped.`)) return;
    try {
      const r = await apiRequest("POST", `/api/pipeline/channels/${encodeURIComponent(channelId)}/import-folder`, {});
      const data = await r.json() as { added: number; skipped: number; scanned: number; folder: string };
      toast({
        title: data.added > 0 ? `Imported ${data.added} file${data.added === 1 ? "" : "s"}` : "Nothing new to import",
        description: `Scanned ${data.scanned} in ${data.folder}${data.skipped ? `, ${data.skipped} already tracked` : ""}`,
      });
      fetchVirtualChannels();
      fetchState();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Import failed", description: e.message });
    }
  };

  const addChannel = async () => {
    if (!newChannelName || !newChannelUrl) return;
    let url = newChannelUrl.trim();
    if (newChannelKind === "folder" && !url.startsWith("file://")) {
      // Normalize backslashes (Windows paths or pasted-from-doc text) to
      // forward slashes, and add the leading "/" before a drive letter so
      // "C:\Users\foo" becomes a valid file:///C:/Users/foo URL on every OS.
      let p = url.replace(/\\/g, "/");
      if (/^[A-Za-z]:/.test(p)) p = `/${p}`;
      url = `file://${p}`;
    }
    try {
      await apiRequest("POST", "/api/pipeline/channels", {
        name: newChannelName,
        url,
        category: newChannelCategory,
      });
      setNewChannelName(""); setNewChannelUrl("");
      fetchConfig(); fetchState();
      toast({ title: newChannelKind === "folder" ? "Folder added" : "Subscribed to channel" });
    } catch (e: any) { toast({ variant: "destructive", title: "Error", description: e.message }); }
  };

  const removeChannel = async (id: string) => {
    await apiRequest("DELETE", `/api/pipeline/channels/${id}`);
    fetchConfig(); fetchState();
    toast({ title: "Removed" });
  };

  const updateChannelCategory = async (id: string, category: "personal" | "work") => {
    try {
      await apiRequest("PATCH", `/api/pipeline/channels/${id}`, { category });
      fetchConfig();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Category change failed", description: e.message });
    }
  };

  const toggleChannel = async (id: string, enabled: boolean) => {
    await apiRequest("PATCH", `/api/pipeline/channels/${id}`, { enabled });
    fetchConfig(); fetchState();
  };

  const toggleChannelDiarize = async (id: string, diarize: boolean) => {
    await apiRequest("PATCH", `/api/pipeline/channels/${id}`, { diarize });
    fetchConfig();
  };

  const toggleChannelShorts = async (id: string, include_shorts: boolean) => {
    await apiRequest("PATCH", `/api/pipeline/channels/${id}`, { include_shorts });
    fetchConfig();
  };

  /** Rename a channel's display name. The folder on disk keeps its
   *  current name (renaming would shift video_path for every existing
   *  entry); new downloads land in a folder based on the new name. */
  const renameChannel = async (ch: { id: string; name: string }) => {
    const next = window.prompt(`Rename channel "${ch.name}":`, ch.name);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === ch.name) return;
    try {
      await apiRequest("PATCH", `/api/pipeline/channels/${ch.id}`, { name: trimmed });
      toast({ title: "Channel renamed", description: trimmed });
      fetchConfig();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Rename failed", description: e.message });
    }
  };

  /** Walk the channel's videoSaveDir folder and queue any media files
   *  that aren't already tracked in video_queue. Used to import local
   *  files (e.g. a manually-downloaded video sitting alongside the
   *  channel's other content). */
  const importChannelFolder = async (ch: { id: string; name: string }) => {
    if (!confirm(`Scan "${ch.name}"'s save folder for local files to add to the library? Files already tracked are skipped.`)) return;
    try {
      const r = await apiRequest("POST", `/api/pipeline/channels/${ch.id}/import-folder`, {});
      const data = await r.json() as { added: number; skipped: number; scanned: number; folder: string };
      toast({
        title: data.added > 0 ? `Imported ${data.added} file${data.added === 1 ? "" : "s"}` : "Nothing new to import",
        description: `Scanned ${data.scanned} in ${data.folder}${data.skipped ? `, ${data.skipped} already tracked` : ""}`,
      });
      fetchState();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Import failed", description: e.message });
    }
  };

  const toggleGlobalDiarize = async (enabled: boolean) => {
    if (!config) return;
    await apiRequest("POST", "/api/pipeline/config", {
      ...config,
      processing: { ...config.processing, diarizationEnabled: enabled },
    });
    fetchConfig();
    toast({
      title: enabled ? "Diarization enabled" : "Diarization disabled",
      description: enabled
        ? "Per-channel toggles now control which channels diarize."
        : "All transcripts will skip speaker identification until re-enabled.",
    });
  };

  const archiveChannel = async (id: string) => {
    setArchiving(prev => ({ ...prev, [id]: true }));
    setArchiveMsg(prev => ({ ...prev, [id]: "Full scan running..." }));
    try {
      const r = await apiRequest("POST", `/api/pipeline/archive/${id}`);
      const data = await r.json();
      setArchiveMsg(prev => ({ ...prev, [id]: `Scanned ${data.scanned} videos, ${data.newVideos} new` }));
      toast({ title: "Full scan complete", description: `${data.scanned} videos scanned, ${data.newVideos} added to queue` });
      fetchState();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Full scan failed", description: e.message });
      setArchiveMsg(prev => ({ ...prev, [id]: "" }));
    } finally {
      setArchiving(prev => ({ ...prev, [id]: false }));
    }
  };

  const retranscribe = async (videoId: string, channelId: string) => {
    const key = `${channelId}:${videoId}`;
    setRetranscribing(p => ({ ...p, [key]: true }));
    try {
      const r = await apiRequest("POST", "/api/pipeline/retranscribe", { videoId, channelId, model: retransModel });
      const job = await r.json();
      toast({ title: "Re-transcribing", description: `Model: ${retransModel}` });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Re-transcribe failed", description: e.message });
    } finally {
      setRetranscribing(p => ({ ...p, [key]: false }));
    }
  };

  const handleVideoFetched = (video: VideoInfo) => {
    setVideoData(video);
    setVideoError(null);
    // Reset stale transcribe-progress state from a previous URL.
    setManualTranscribeId(null);
  };

  const handleVideoError = (errorMessage: string) => {
    setVideoError(errorMessage);
    setVideoData(null);
  };

  const handleTranscribe = async (filePath: string, videoTitle: string, uploadDate?: string | null, videoId?: string, channelId?: string | null, channelName?: string | null) => {
    try {
      await apiRequest("POST", "/api/pipeline/transcribe-file", { filePath, title: videoTitle, uploadDate, videoId, channelId, channelName });
      toast({ title: "Transcription started", description: videoTitle });
      // Track this video so VideoPreview can show its progress until done.
      if (videoId) setManualTranscribeId(videoId);
      fetchState();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Transcribe failed", description: e.message });
    }
  };

  const statusBadge = (status: string) => {
    const m: Record<string, { v: "default"|"secondary"|"destructive"|"outline"; icon: any; label: string }> = {
      pending:     { v: "secondary", icon: Clock, label: "Pending" },
      waiting_live:{ v: "secondary", icon: Radio, label: "Live" },
      downloading: { v: "secondary", icon: Download, label: "Downloading" },
      extracting_audio:{ v: "secondary", icon: Mic, label: "Audio" },
      transcribing:{ v: "secondary", icon: FileText, label: "Transcribing" },
      saving_md:   { v: "secondary", icon: FileDown, label: "Saving" },
      complete:    { v: "default", icon: CheckCircle, label: "Done" },
      failed:      { v: "destructive", icon: XCircle, label: "Failed" },
    };
    const s = m[status] || { v: "outline" as const, icon: AlertCircle, label: status };
    return <Badge variant={s.v} className="gap-1"><s.icon className="h-3 w-3"/>{s.label}</Badge>;
  };

  const running = state?.status === "running";

  return (
    <div className="space-y-4">
      {/* Pipeline status; global controls are in the app header. */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Pipeline
              <Badge variant={running ? "default" : "secondary"}>{running ? "Running" : state?.status || "?"}</Badge>
            </CardTitle>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{state?.totalCompleted || 0} done</span>
            <span>{state?.pendingCount || 0} pending</span>
            {state?.dailyDownloadCap !== undefined && state.dailyDownloadCap > 0 && (
              <span className={
                (state.dailyDownloadCount ?? 0) >= state.dailyDownloadCap
                  ? "font-medium text-amber-600 dark:text-amber-400"
                  : ""
              }>
                {state.dailyDownloadCount ?? 0} / {state.dailyDownloadCap} today
              </span>
            )}
            <span
              className={
                "inline-flex items-center gap-1 " +
                (ytdlpHealth === null
                  ? ""
                  : ytdlpHealth.ok
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "font-medium text-red-600 dark:text-red-400")
              }
              title={
                ytdlpHealth
                  ? `${ytdlpHealth.kind} • ${ytdlpHealth.path}${ytdlpHealth.error ? ` • ${ytdlpHealth.error}` : ""}`
                  : "Probing yt-dlp..."
              }
            >
              <span className={"inline-block h-2 w-2 rounded-full " + (
                ytdlpHealth === null
                  ? "bg-muted-foreground/40"
                  : ytdlpHealth.ok
                    ? "bg-emerald-500"
                    : "bg-red-500"
              )} />
              yt-dlp {ytdlpHealth?.version || (ytdlpHealthChecking ? "…" : "unreachable")}
              <button
                type="button"
                className="ml-1 underline-offset-2 hover:underline disabled:opacity-50"
                onClick={() => fetchYtdlpHealth(true)}
                disabled={ytdlpHealthChecking}
              >
                {ytdlpHealthChecking ? "checking…" : "recheck"}
              </button>
              {ytdlpHealth?.updatable && (
                <button
                  type="button"
                  className="ml-1 underline-offset-2 hover:underline disabled:opacity-50"
                  onClick={updateYtdlp}
                  disabled={ytdlpUpdating || ytdlpHealthChecking}
                  title="Download the latest yt-dlp release from GitHub, verify it, sign it for Apple Silicon, and swap it in. The .app's signed bundle is unaffected."
                >
                  {ytdlpUpdating ? "updating…" : "update"}
                </button>
              )}
            </span>
            {state?.lastCheck && <span>Last check: {new Date(state.lastCheck).toLocaleTimeString()}</span>}
          </div>
          {ytdlpHealth && !ytdlpHealth.ok && <YtdlpInstallHelp />}
        </CardHeader>
      </Card>

      {/* Single-video download + transcription */}
      <UrlInput
        onVideoFetched={handleVideoFetched}
        onLoading={setIsVideoLoading}
        onError={handleVideoError}
      />

      {isVideoLoading && <LoadingIndicator />}
      {videoError && <ErrorMessage error={videoError} />}

      {videoData && (() => {
        const transcribeJob = manualTranscribeId
          ? state?.jobs.find(j => j.videoId === manualTranscribeId) ?? null
          : null;
        return (
          <VideoPreview
            videoData={videoData}
            downloadProgress={downloadProgress}
            isDownloading={isDownloading}
            setIsDownloading={setIsDownloading}
            updateDownloadProgress={setDownloadProgress}
            downloadLocation={config?.videoSaveDir || ""}
            showTranscribe
            onTranscribe={handleTranscribe}
            transcribeJob={transcribeJob ? {
              status: transcribeJob.status,
              progress: transcribeJob.progress,
              error: transcribeJob.error,
            } : null}
            downloadCategory={headerCategory === "work" ? "work" : "personal"}
          />
        );
      })()}

      {/* Recurring channel subscriptions and local folder sources */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Subscriptions & folders</CardTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={config?.processing?.diarizationEnabled !== false}
                onCheckedChange={toggleGlobalDiarize}
                aria-label="Speaker diarization (master switch)"
              />
              <span>Speaker diarization</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">Subscribe to YouTube channels or add local folders. While running, the pipeline checks enabled sources for new media and queues it automatically.</p>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="space-y-3 border-b pb-4">
            <h3 className="text-sm font-medium">Add a source</h3>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Source type</span>
              <div className="inline-flex overflow-hidden rounded-md border">
                <button
                  type="button"
                  onClick={() => setNewChannelKind("youtube")}
                  aria-pressed={newChannelKind === "youtube"}
                  className={`px-2.5 py-1 transition-colors ${
                    newChannelKind === "youtube"
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  YouTube channel
                </button>
                <button
                  type="button"
                  onClick={() => setNewChannelKind("folder")}
                  aria-pressed={newChannelKind === "folder"}
                  className={`border-l px-2.5 py-1 transition-colors ${
                    newChannelKind === "folder"
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Local folder
                </button>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="Source name"
                aria-label="Source name"
                value={newChannelName}
                onChange={e => setNewChannelName(e.target.value)}
                className="flex-1"
              />
              {newChannelKind === "folder" ? (
                <div className="flex-[2]">
                  <FolderInput
                    value={newChannelUrl}
                    onChange={setNewChannelUrl}
                    placeholder="/absolute/path/to/folder"
                    prompt="Choose the folder to scan for local media"
                    className="font-mono text-xs"
                  />
                </div>
              ) : (
                <Input
                  placeholder="https://www.youtube.com/@channel"
                  aria-label="YouTube channel URL"
                  value={newChannelUrl}
                  onChange={e => setNewChannelUrl(e.target.value)}
                  className="flex-[2] font-mono text-xs"
                />
              )}
              <Select
                value={newChannelCategory}
                onValueChange={(v) => setNewChannelCategory(v as "personal" | "work")}
              >
                <SelectTrigger className="w-[110px]" aria-label="Source category"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal</SelectItem>
                  <SelectItem value="work">Work</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" onClick={addChannel} disabled={!newChannelName || !newChannelUrl}>
                <Plus className="h-4 w-4"/>{newChannelKind === "folder" ? "Add folder" : "Subscribe"}
              </Button>
            </div>
            {newChannelKind === "folder" ? (
              <p className="text-[11px] text-muted-foreground">
                Paste an absolute path. The pipeline will scan it recursively for video and audio files. New files are picked up on the next check.
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Add a channel URL to subscribe to new uploads. Use Full Scan on a saved source to find older videos.
              </p>
            )}
          </div>

          <h3 className="pt-2 text-sm font-medium">Your sources</h3>
          {config?.channels
            .filter(ch => !serverCategory || (ch.category ?? "personal") === serverCategory)
            .map(ch => {
            const isLocal = ch.url.startsWith("file://");
            const displayUrl = isLocal
              ? decodeURIComponent(ch.url.replace(/^file:\/\//, ""))
              : ch.url;
            return (
              <div key={ch.id} className="rounded-md border bg-muted/30 px-2 py-2 space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <Switch checked={ch.enabled} onCheckedChange={v => toggleChannel(ch.id, v)}/>
                    {isLocal
                      ? <FolderOpen className="h-3.5 w-3.5 text-muted-foreground" aria-label="Local folder channel" />
                      : <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-label="YouTube channel" />}
                    <span className="font-medium text-sm truncate">{ch.name}</span>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm" variant="outline"
                      onClick={() => archiveChannel(ch.id)}
                      disabled={archiving[ch.id]}
                    >
                      {archiving[ch.id] ? <Loader2 className="h-3 w-3 animate-spin"/> : <Archive className="h-3 w-3"/>}
                      {isLocal ? "Rescan" : "Full Scan"}
                    </Button>
                    {!isLocal && (
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => importChannelFolder(ch)}
                        title="Scan this channel's save folder for local files to import"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        Import folder
                      </Button>
                    )}
                    <Button
                      size="icon" variant="ghost"
                      onClick={() => renameChannel(ch)}
                      aria-label="Rename channel"
                      title="Rename channel"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => removeChannel(ch.id)} aria-label="Remove channel">
                      <Trash2 className="h-4 w-4 text-destructive"/>
                    </Button>
                  </div>
                </div>
                <div className="text-xs text-muted-foreground truncate font-mono">{displayUrl}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={ch.diarize !== false}
                    onCheckedChange={v => toggleChannelDiarize(ch.id, v)}
                    disabled={config?.processing?.diarizationEnabled === false}
                    aria-label="Diarize transcripts (identify speakers)"
                  />
                  <span className={config?.processing?.diarizationEnabled === false ? "opacity-50" : ""}>
                    {config?.processing?.diarizationEnabled === false
                      ? "Identify speakers (master switch is off — toggle above)"
                      : "Identify speakers (turn off for single-speaker content — faster)"}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={!!ch.include_shorts}
                    onCheckedChange={v => toggleChannelShorts(ch.id, v)}
                    aria-label="Include YouTube Shorts when scanning this channel"
                  />
                  <span>Include Shorts (off by default — most are clips of full videos)</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="w-24 shrink-0">Category</span>
                  <Select
                    value={ch.category ?? "personal"}
                    onValueChange={(v) => updateChannelCategory(ch.id, v as "personal" | "work")}
                  >
                    <SelectTrigger className="h-7 w-[120px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">Personal</SelectItem>
                      <SelectItem value="work">Work</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {archiveMsg[ch.id] && <div className="text-xs text-muted-foreground">{archiveMsg[ch.id]}</div>}
              </div>
            );
          })}
          {(!config?.channels.length) && <p className="text-xs text-muted-foreground">No subscriptions or folders yet. Add your first source above.</p>}

          {/* Virtual channels — exist only in video_queue.channel_id,
              never had a channels-table row. Surface them so the user
              can still rename + scan their folder for local files. */}
          {virtualChannels.length > 0 && (
            <div className="space-y-1 pt-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">One-off downloads (not subscribed)</div>
              {virtualChannels.map(vc => (
                <div key={vc.channelId} className="rounded-md border border-dashed bg-muted/20 px-2 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-medium text-sm truncate">{vc.channelId}</span>
                      <span className="text-[10px] text-muted-foreground">{vc.videoCount} video{vc.videoCount === 1 ? "" : "s"}</span>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm" variant="ghost"
                        onClick={() => importVirtualFolder(vc.channelId)}
                        title="Scan this channel's folder for additional local files"
                      >
                        <FolderOpen className="h-3.5 w-3.5" />
                        Import folder
                      </Button>
                      <Button
                        size="icon" variant="ghost"
                        onClick={() => renameVirtualChannel(vc.channelId)}
                        aria-label="Rename channel"
                        title="Rename — updates every matching row in video_queue"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}


        </CardContent>
      </Card>

      {/* Live status display for active pipeline jobs */}
      {state && state.jobs.some(j => j.status !== "complete" && j.status !== "failed") && (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4 animate-pulse"/>Live Status</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {state.jobs.filter(j => j.status !== "complete" && j.status !== "failed").slice(0, 3).map(job => (
              <div key={job.id} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium truncate">{job.videoTitle}</span>
                  {statusBadge(job.status)}
                </div>
                {(job.status === "downloading" || job.status === "extracting_audio" || job.status === "transcribing") && (
                  <Progress value={job.progress} className="h-1.5 mt-1.5" />
                )}
                {job.status === "downloading" && <p className="text-xs text-muted-foreground mt-1">Downloading video with yt-dlp…</p>}
                {job.status === "extracting_audio" && <p className="text-xs text-muted-foreground mt-1">Extracting audio with ffmpeg (16kHz mono WAV)…</p>}
                {job.status === "transcribing" && <p className="text-xs text-muted-foreground mt-1">{transcribingLabel(job.model || config?.transcription?.model, config?.transcription.device)}</p>}
                {job.status === "saving_md" && <p className="text-xs text-muted-foreground mt-1">Saving transcript as markdown…</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Recent Jobs */}
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-1.5"><List className="h-4 w-4"/>Recent Jobs</CardTitle></CardHeader>
        <CardContent>
          <div className="max-h-[480px] overflow-y-auto pr-1">
            <div className="space-y-2">
              {state?.jobs.map(job => (
                <div key={job.id} className="rounded-md border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium truncate flex-1">{job.videoTitle}</span>
                    {statusBadge(job.status)}
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {job.channelName} · {new Date(job.startedAt).toLocaleString()}
                    {job.retries > 0 && ` · ${job.retries} retries`}
                  </div>
                  {job.error && <p className="mt-1 text-xs text-destructive line-clamp-2">{job.error}</p>}
                  {(job.status === "downloading" || job.status === "extracting_audio" || job.status === "transcribing") && (
                    <Progress value={job.progress} className="h-1.5 mt-2"/>
                  )}
                  {job.status === "complete" && job.transcriptionResult && (
                    <div className="flex gap-1 mt-1 flex-wrap items-center">
                      <Badge variant="outline" className="text-xs">{job.transcriptionResult.word_count} words</Badge>
                      <Badge variant="outline" className="text-xs">{job.transcriptionResult.realtime_factor}x realtime</Badge>
                      <Select value={retransModel} onValueChange={setRetransModel}>
                        <SelectTrigger className="h-6 text-xs w-[90px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {visibleModels(platform, retransModel, config?.transcription?.engine || null).map((opt) => (
                            <SelectItem key={opt.value} value={opt.value} className="text-xs">{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm" variant="ghost" className="h-6 text-xs"
                        onClick={() => retranscribe(job.videoId, job.channelId)}
                        disabled={retranscribing[`${job.channelId}:${job.videoId}`]}
                      >
                        {retranscribing[`${job.channelId}:${job.videoId}`]
                          ? <Loader2 className="h-3 w-3 animate-spin"/>
                          : <RotateCcw className="h-3 w-3"/>}
                        <span className="ml-1">Re-transcribe</span>
                      </Button>
                    </div>
                  )}
                </div>
              ))}
              {(!state?.jobs.length) && <p className="text-xs text-muted-foreground">No jobs yet.</p>}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Inline help shown under the yt-dlp status badge when the binary is
 *  missing. Picks platform-appropriate install commands so the user
 *  doesn't have to look them up. yt-dlp is not bundled on purpose
 *  (see server/yt-dlp-bin.ts comments) — the system binary stays
 *  fresh as YouTube tightens anti-bot. */
function YtdlpInstallHelp() {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const isMac = /Mac OS X|Macintosh/i.test(ua);
  const isWin = /Windows/i.test(ua);
  const primary = isMac
    ? { label: "Homebrew", cmd: "brew install yt-dlp" }
    : isWin
      ? { label: "winget", cmd: "winget install yt-dlp.yt-dlp" }
      : { label: "apt", cmd: "sudo apt install yt-dlp" };
  const alt = isMac || isWin ? null : { label: "Homebrew", cmd: "brew install yt-dlp" };

  return (
    <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-900 dark:text-amber-200">
      <div className="font-medium">yt-dlp isn't installed.</div>
      <div className="mt-0.5 text-amber-900/80 dark:text-amber-200/80">
        Only needed for downloading YouTube videos — offline audio/video files import without it.
      </div>
      <div className="mt-2 space-y-1 font-mono text-[11px]">
        <div>
          <span className="mr-2 text-amber-900/60 dark:text-amber-200/60">{primary.label}</span>
          <code className="rounded bg-amber-500/10 px-1.5 py-0.5">{primary.cmd}</code>
        </div>
        {alt && (
          <div>
            <span className="mr-2 text-amber-900/60 dark:text-amber-200/60">{alt.label}</span>
            <code className="rounded bg-amber-500/10 px-1.5 py-0.5">{alt.cmd}</code>
          </div>
        )}
      </div>
    </div>
  );
}
