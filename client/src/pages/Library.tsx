import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  AlertCircle,
  CheckCircle,
  Clock,
  Database,
  Download,
  FileText,
  List,
  Loader2,
  Mic,
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
}

interface ConfigResponse {
  channels: Channel[];
  transcription?: { model?: string };
}

function formatDate(uploadDate: string | null): string {
  if (!uploadDate) return "";
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }
  return uploadDate;
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
    downloading: { v: "secondary", icon: Download, label: "Downloading" },
    extracting_audio: { v: "secondary", icon: Mic, label: "Extracting" },
    transcribing: { v: "secondary", icon: FileText, label: "Transcribing" },
    saving_md: { v: "secondary", icon: FileText, label: "Saving" },
    complete: { v: "default", icon: CheckCircle, label: "Done" },
    failed: { v: "destructive", icon: XCircle, label: "Failed" },
  };
  const statusConfig = map[status] || { v: "outline" as const, icon: AlertCircle, label: status };
  return (
    <Badge variant={statusConfig.v} className="gap-1">
      <statusConfig.icon className="h-3 w-3" />
      {statusConfig.label}
    </Badge>
  );
}

function modelSelector(value: string, onChange: (value: string) => void) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-6 text-xs w-[140px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="large-v3">large-v3</SelectItem>
        <SelectItem value="large-v3-turbo">turbo</SelectItem>
        <SelectItem value="medium">medium</SelectItem>
        <SelectItem value="small">small</SelectItem>
        <SelectItem value="tiny">tiny</SelectItem>
        <SelectItem value="parakeet-tdt-0.6b-v2" disabled>parakeet soon</SelectItem>
      </SelectContent>
    </Select>
  );
}

export default function Library() {
  const [entries, setEntries] = useState<QueueEntry[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [channels, setChannels] = useState<Channel[]>([]);
  const [model, setModel] = useState("large-v3");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const [loading, setLoading] = useState(false);
  const [retranscribing, setRetranscribing] = useState<Record<string, boolean>>({});
  const { toast } = useToast();

  const channelNames = useMemo(() => {
    return Object.fromEntries(channels.map(ch => [ch.id, ch.name]));
  }, [channels]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter(entry => {
      if (status !== "all" && entry.status !== status) return false;
      if (!q) return true;
      const channelName = channelNames[entry.channel_id] || entry.channel_id;
      return [
        entry.title,
        entry.video_id,
        entry.channel_id,
        channelName,
        formatDate(entry.upload_date),
        entry.status,
      ].some(value => value.toLowerCase().includes(q));
    }).sort((a, b) => {
      const aDate = a.upload_date || "99999999";
      const bDate = b.upload_date || "99999999";
      if (aDate !== bDate) return aDate.localeCompare(bDate);
      return a.title.localeCompare(b.title);
    });
  }, [channelNames, entries, query, status]);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [queueRes, configRes] = await Promise.all([
        apiRequest("GET", "/api/pipeline/queue?limit=5000"),
        apiRequest("GET", "/api/pipeline/config"),
      ]);
      const queue = await queueRes.json() as QueueResponse;
      const config = await configRes.json() as ConfigResponse;
      setEntries(queue.recent || []);
      setCounts(queue.counts || {});
      setChannels(config.channels || []);
      setModel(config.transcription?.model || "large-v3");
    } catch (error: any) {
      toast({ variant: "destructive", title: "Library load failed", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

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

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Database className="h-5 w-5" />
              Transcription Library
            </CardTitle>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search videos"
                  className="h-9 pl-8 sm:w-72"
                />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="h-9 sm:w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="downloading">Downloading</SelectItem>
                  <SelectItem value="transcribing">Transcribing</SelectItem>
                  <SelectItem value="complete">Complete</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={fetchData} disabled={loading}>
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{entries.length} total loaded</Badge>
            {Object.entries(counts).map(([key, value]) => (
              <Badge key={key} variant={statusVariant(key)}>{key}: {value}</Badge>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium flex items-center gap-1">
              <List className="h-4 w-4" />
              Records
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Re-transcribe model</span>
              {modelSelector(model, setModel)}
            </div>
          </div>
          <div className="space-y-2">
              {filtered.map(entry => {
                const key = `${entry.channel_id}:${entry.video_id}`;
                const canRetranscribe = !!entry.video_path && entry.status !== "downloading" && entry.status !== "transcribing";
                return (
                  <div key={key} className="p-3 rounded border text-sm">
                    <div className="flex items-center justify-between mb-1 gap-2">
                      <span className="font-medium truncate flex-1">{entry.title}</span>
                      {statusBadge(entry.status)}
                    </div>
                    <div className="text-xs text-muted-foreground mb-1">
                      {channelNames[entry.channel_id] || entry.channel_id} • {formatDate(entry.upload_date) || "No upload date"}
                      {entry.retries > 0 && ` • ${entry.retries} retries`}
                      {entry.updated_at && ` • updated ${new Date(entry.updated_at).toLocaleString()}`}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono mb-1">{entry.video_id}</div>
                    {entry.error && <p className="text-xs text-red-500 mt-1">{entry.error}</p>}
                    <div className="flex gap-1 mt-1 flex-wrap items-center">
                      {entry.word_count > 0 && <Badge variant="outline" className="text-xs">{entry.word_count} words</Badge>}
                      {entry.video_path && <Badge variant="outline" className="text-xs">video saved</Badge>}
                      {entry.md_path && <Badge variant="outline" className="text-xs">transcript saved</Badge>}
                      {modelSelector(model, setModel)}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-xs"
                        disabled={!canRetranscribe || retranscribing[key]}
                        onClick={() => retranscribe(entry)}
                      >
                        {retranscribing[key]
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <RotateCcw className="h-3 w-3" />}
                        <span className="ml-1">Re-transcribe</span>
                      </Button>
                    </div>
                  </div>
                );
              })}
              {!filtered.length && (
                <p className="text-xs text-muted-foreground p-3">No videos match this filter.</p>
              )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
