import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Bookmark, Calendar, Clock, Play, RefreshCw, Search, Trash2 } from "lucide-react";

interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

interface ClipEntry {
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
  video_path: string | null;
  md_path: string | null;
  word_count: number;
  is_live: number;
  duration: number | null;
  status: string;
}

function formatUploadDate(uploadDate: string | null): string {
  if (!uploadDate) return "No date";
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

export default function Clips() {
  const [clips, setClips] = useState<ClipEntry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("all");
  const [loading, setLoading] = useState(false);
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { toast } = useToast();

  const clipCountByVideo = useMemo(() => {
    return new Set(clips.map(clip => `${clip.channel_id}:${clip.video_id}`)).size;
  }, [clips]);

  const loadData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        channelId,
        limit: "250",
        t: String(Date.now()),
      });
      const [clipsRes, configRes] = await Promise.all([
        apiRequest("GET", `/api/clips?${params.toString()}`),
        apiRequest("GET", `/api/pipeline/config?t=${Date.now()}`),
      ]);
      const clipsData = await clipsRes.json() as { rows?: ClipEntry[] };
      const configData = await configRes.json() as { channels?: Channel[] };
      setClips(clipsData.rows || []);
      setChannels(configData.channels || []);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Clips load failed", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [channelId]);

  const deleteClip = async (clip: ClipEntry) => {
    try {
      await apiRequest("DELETE", `/api/clips/${clip.id}`);
      setClips(current => current.filter(item => item.id !== clip.id));
      toast({ title: "Clip deleted" });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Delete failed", description: error.message });
    }
  };

  const openClip = (clip: ClipEntry) => {
    setDrawerVideo({
      video_id: clip.video_id,
      channel_id: clip.channel_id,
      channel_name: clip.channel_name || clip.channel_id,
      title: clip.title,
      upload_date: clip.upload_date,
      duration: clip.duration,
      status: clip.status,
      is_live: clip.is_live,
      video_path: clip.video_path,
      md_path: clip.md_path,
      word_count: clip.word_count,
    });
    setDrawerSeconds(clip.start_seconds);
    setDrawerOpen(true);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="flex items-center gap-2">
              <Bookmark className="h-4 w-4" />
              Clips
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") loadData(); }}
                  placeholder="Search clips and notes"
                  className="h-9 pl-8 w-full sm:w-80"
                />
              </div>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  {channels.map(channel => <SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={loadData} disabled={loading} className="h-9">
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{clips.length} clips</Badge>
            <Badge variant="outline">{clipCountByVideo} videos</Badge>
          </div>
        </CardHeader>
      </Card>

      <div className="space-y-3">
        {clips.map(clip => (
          <Card key={clip.id}>
            <CardContent className="p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div className="min-w-0 space-y-2">
                  <div>
                    <div className="font-medium line-clamp-2">{clip.title}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{clip.channel_name || clip.channel_id}</span>
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatUploadDate(clip.upload_date)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTimestamp(clip.start_seconds)} - {formatTimestamp(clip.end_seconds)}
                      </span>
                    </div>
                  </div>
                  <p className="text-sm leading-6">{clip.quote}</p>
                  {clip.note && (
                    <p className="rounded-md border bg-muted/50 p-2 text-sm text-muted-foreground">{clip.note}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-2 md:justify-end">
                  <Button size="sm" variant="outline" disabled={!clip.video_path} onClick={() => openClip(clip)}>
                    <Play className="h-3 w-3" />
                    Open
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteClip(clip)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
        {!clips.length && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No clips saved yet.
            </CardContent>
          </Card>
        )}
      </div>

      <VideoDrawer
        open={drawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
        onOpenChange={setDrawerOpen}
      />
    </div>
  );
}
