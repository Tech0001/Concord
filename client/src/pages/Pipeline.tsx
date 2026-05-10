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
  Play, Square, RefreshCw, Plus, Trash2, Activity,
  CheckCircle, XCircle, Clock, AlertCircle, Radio,
  FileText, Download, Mic, FileDown, Loader2, Archive, List,
  HardDrive, RotateCcw, ChevronDown, FileAudio, FolderOpen, Globe
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import FolderInput from "@/components/FolderInput";

interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  /** Run speaker diarization for this channel. Undefined treated as true
   *  (legacy channels created before the toggle existed default-on). */
  diarize?: boolean;
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
  transcription: { model: string; language: string; device: string };
  processing: { keepVideo: boolean; keepAudio: boolean; waitForLiveToFinish: boolean; diarizationEnabled: boolean };
}

const CODEC_OPTIONS: { value: string; label: string }[] = [
  { value: "any",  label: "Auto (largest available)" },
  { value: "av01", label: "AV1 (smallest, modern)" },
  { value: "vp9",  label: "VP9 (small, broad support)" },
  { value: "avc1", label: "H.264 (universal, largest)" },
];

function transcribingLabel(model: string | undefined): string {
  if (!model) return "Transcribing…";
  const m = model.toLowerCase();
  if (m.includes("parakeet")) return `Transcribing with Parakeet (${model.split("/").pop()}) on CUDA…`;
  if (m.startsWith("fluid-") || m.includes("fluidaudio")) return "Transcribing with FluidAudio on Apple Neural Engine…";
  return `Transcribing with faster-whisper (${model}) on CUDA…`;
}

function codecLabel(value: string): string {
  return CODEC_OPTIONS.find(o => o.value === value)?.label || value;
}

interface QueueData {
  counts: Record<string, number>;
  recent: any[];
}

// All supported transcription engines + which platforms they actually run on.
// Filtering the dropdown saves users from picking a model that will fail at
// transcribe time. `null` = available on all platforms.
const TRANSCRIPTION_OPTIONS: { value: string; label: string; platforms: NodeJS.Platform[] | null }[] = [
  { value: "fluid-parakeet-tdt-v3",        label: "Parakeet v3 (Apple Neural Engine, fastest on Mac)", platforms: ["darwin"] },
  { value: "nvidia/parakeet-tdt-0.6b-v3",  label: "parakeet-v3 (multilingual, fastest on CUDA)",       platforms: ["linux"] },
  { value: "large-v3",                     label: "whisper large-v3 (multilingual)",                   platforms: ["linux"] },
  { value: "large-v3-turbo",               label: "whisper turbo",                                     platforms: ["linux"] },
  { value: "medium",                       label: "whisper medium",                                    platforms: ["linux"] },
  { value: "small",                        label: "whisper small",                                     platforms: ["linux"] },
  { value: "tiny",                         label: "whisper tiny",                                      platforms: ["linux"] },
];

function visibleModels(platform: NodeJS.Platform | null, currentValue: string | undefined) {
  // Hide engines that can't run here, but always keep the saved value visible
  // so users can see what's set and change it (instead of it appearing blank).
  return TRANSCRIPTION_OPTIONS.filter((o) => {
    if (o.value === currentValue) return true;
    if (!platform || !o.platforms) return true;
    return o.platforms.includes(platform);
  });
}

export default function PipelineStatus() {
  const [state, setState] = useState<PipelineState | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null);
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelUrl, setNewChannelUrl] = useState("");
  const [newChannelKind, setNewChannelKind] = useState<"youtube" | "folder">("youtube");
  const [archiving, setArchiving] = useState<Record<string, boolean>>({});
  const [retransModel, setRetransModel] = useState("large-v3");
  const [retranscribing, setRetranscribing] = useState<Record<string, boolean>>({});
  const [archiveMsg, setArchiveMsg] = useState<Record<string, string>>({});
  const [editDir, setEditDir] = useState(false);
  const [videoSaveDir, setVideoSaveDir] = useState("");
  const [transcriptDir, setTranscriptDir] = useState("");
  const [videoQuality, setVideoQuality] = useState("1080");
  const [videoCodec, setVideoCodec] = useState("any");
  const [transcriptionModel, setTranscriptionModel] = useState("large-v3");

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

  useEffect(() => {
    fetchState();
    fetchConfig();
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
      const c = await r.json();
      setConfig(c);
      setVideoSaveDir(c.videoSaveDir || "");
      setTranscriptDir(c.transcriptDir || "");
      setVideoQuality(c.videoQuality || "1080");
      setVideoCodec(c.videoCodec || "any");
      setTranscriptionModel(c.transcription?.model || "large-v3");
    } catch {}
  };

  const start = async () => { await apiRequest("POST", "/api/pipeline/start"); fetchState(); toast({ title: "Started" }); };
  const stop = async () => { await apiRequest("POST", "/api/pipeline/stop"); fetchState(); toast({ title: "Stopped" }); };
  const checkNow = async () => {
    const r = await apiRequest("POST", "/api/pipeline/check-now");
    const data = await r.json();
    fetchState();
    toast({ title: "Check complete", description: `${data.newVideos ?? 0} new videos queued` });
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
      await apiRequest("POST", "/api/pipeline/channels", { name: newChannelName, url });
      setNewChannelName(""); setNewChannelUrl("");
      fetchConfig(); fetchState();
      toast({ title: "Channel added" });
    } catch (e: any) { toast({ variant: "destructive", title: "Error", description: e.message }); }
  };

  const removeChannel = async (id: string) => {
    await apiRequest("DELETE", `/api/pipeline/channels/${id}`);
    fetchConfig(); fetchState();
    toast({ title: "Removed" });
  };

  const toggleChannel = async (id: string, enabled: boolean) => {
    await apiRequest("PATCH", `/api/pipeline/channels/${id}`, { enabled });
    fetchConfig(); fetchState();
  };

  const toggleChannelDiarize = async (id: string, diarize: boolean) => {
    await apiRequest("PATCH", `/api/pipeline/channels/${id}`, { diarize });
    fetchConfig();
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

  const saveDirs = async () => {
    if (!config) return;
    await apiRequest("POST", "/api/pipeline/config", {
      ...config,
      videoSaveDir,
      transcriptDir,
      videoQuality,
      videoCodec,
      transcription: {
        ...config.transcription,
        model: transcriptionModel,
      },
    });
    setEditDir(false);
    fetchConfig();
    toast({ title: "Pipeline settings updated" });
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
    <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
      {/* Controls */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Pipeline
              <Badge variant={running ? "default" : "secondary"}>{running ? "Running" : state?.status || "?"}</Badge>
            </CardTitle>
            <div className="flex gap-2">
              {running ? (
                <Button size="sm" variant="outline" onClick={stop}><Square className="h-4 w-4"/>Stop</Button>
              ) : (
                <Button size="sm" onClick={start}><Play className="h-4 w-4"/>Start</Button>
              )}
              <Button size="sm" variant="outline" onClick={checkNow}><RefreshCw className="h-4 w-4"/>Check</Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>{state?.totalCompleted || 0} done</span>
            <span>{state?.pendingCount || 0} pending</span>
            {state?.lastCheck && <span>Last check: {new Date(state.lastCheck).toLocaleTimeString()}</span>}
          </div>
        </CardHeader>
      </Card>

      {/* Manual download + transcribe — uses Video save from Settings below */}
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
          />
        );
      })()}

      {/* Directories */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-1.5"><HardDrive className="h-4 w-4"/>Settings</CardTitle>
            <Button size="sm" variant="ghost" onClick={() => setEditDir(!editDir)}>{editDir ? "Cancel" : "Edit"}</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 text-xs">
          {editDir ? (
            <>
              <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                <span className="text-muted-foreground">Working (temp)</span>
                <code className="font-mono text-foreground">{config?.workingDir}</code>
              </div>
              <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                <label className="text-muted-foreground" htmlFor="videoSaveDir">Video save</label>
                <FolderInput id="videoSaveDir" value={videoSaveDir} onChange={setVideoSaveDir} prompt="Pick the parent folder — saved_videos will be created inside" appendSubfolder="saved_videos" className="h-8 font-mono"/>
              </div>
              <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                <label className="text-muted-foreground" htmlFor="transcriptDir">Transcripts</label>
                <FolderInput id="transcriptDir" value={transcriptDir} onChange={setTranscriptDir} prompt="Pick the parent folder — transcripts will be created inside" appendSubfolder="transcripts" className="h-8 font-mono"/>
              </div>
              <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                <label className="text-muted-foreground">Download quality</label>
                <Select value={videoQuality} onValueChange={setVideoQuality}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Quality" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="480">480p</SelectItem>
                    <SelectItem value="720">720p</SelectItem>
                    <SelectItem value="1080">1080p</SelectItem>
                    <SelectItem value="best">Best available</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                <label className="text-muted-foreground">Video codec</label>
                <Select value={videoCodec} onValueChange={setVideoCodec}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Codec" />
                  </SelectTrigger>
                  <SelectContent>
                    {CODEC_OPTIONS.map(option => (
                      <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-[140px_1fr] items-center gap-2">
                <label className="text-muted-foreground">Transcription model</label>
                <Select value={transcriptionModel} onValueChange={setTranscriptionModel}>
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Model" />
                  </SelectTrigger>
                  <SelectContent>
                    {visibleModels(platform, transcriptionModel).map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button size="sm" onClick={saveDirs}>Save</Button>
            </>
          ) : (
            <div className="grid grid-cols-[140px_1fr] gap-x-2 gap-y-1">
              <span className="text-muted-foreground">Working</span>
              <code className="font-mono text-foreground">{config?.workingDir}</code>
              <span className="text-muted-foreground">Videos</span>
              <code className="font-mono text-foreground">{config?.videoSaveDir}</code>
              <span className="text-muted-foreground">Transcripts</span>
              <code className="font-mono text-foreground">{config?.transcriptDir}</code>
              <span className="text-muted-foreground">Download quality</span>
              <code className="font-mono text-foreground">{config?.videoQuality === "best" ? "Best available" : `${config?.videoQuality || "1080"}p`}</code>
              <span className="text-muted-foreground">Video codec</span>
              <code className="font-mono text-foreground">{codecLabel(config?.videoCodec || "any")}</code>
              <span className="text-muted-foreground">Transcription model</span>
              <code className="font-mono text-foreground">{config?.transcription?.model || "large-v3"}</code>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Channels */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>Channels</CardTitle>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={config?.processing?.diarizationEnabled !== false}
                onCheckedChange={toggleGlobalDiarize}
                aria-label="Speaker diarization (master switch)"
              />
              <span>Speaker diarization</span>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {config?.channels.map(ch => {
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
                {archiveMsg[ch.id] && <div className="text-xs text-muted-foreground">{archiveMsg[ch.id]}</div>}
              </div>
            );
          })}
          {(!config?.channels.length) && <p className="text-xs text-muted-foreground">No channels.</p>}

          <div className="space-y-2 pt-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted-foreground">Source</span>
              <div className="inline-flex overflow-hidden rounded-md border">
                <button
                  type="button"
                  onClick={() => setNewChannelKind("youtube")}
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
            <div className="flex gap-2">
              <Input
                placeholder="Name"
                value={newChannelName}
                onChange={e => setNewChannelName(e.target.value)}
                className="flex-1"
              />
              <Input
                placeholder={newChannelKind === "folder" ? "/absolute/path/to/folder" : "https://www.youtube.com/@channel"}
                value={newChannelUrl}
                onChange={e => setNewChannelUrl(e.target.value)}
                className="flex-[2] font-mono text-xs"
              />
              <Button size="sm" onClick={addChannel} disabled={!newChannelName || !newChannelUrl}>
                <Plus className="h-4 w-4"/>Add
              </Button>
            </div>
            {newChannelKind === "folder" && (
              <p className="text-[11px] text-muted-foreground">
                Paste an absolute path. The pipeline will scan it recursively for video and audio files. New files are picked up on the next check.
              </p>
            )}
          </div>
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
                {job.status === "transcribing" && <p className="text-xs text-muted-foreground mt-1">{transcribingLabel(config?.transcription?.model)}</p>}
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
                          {visibleModels(platform, retransModel).map((opt) => (
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
