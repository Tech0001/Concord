import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Calendar, Clock, DatabaseZap, FileText, Loader2, Play, Radio, Search as SearchIcon } from "lucide-react";

interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

interface ConfigResponse {
  channels: Channel[];
}

interface TranscriptSearchResult {
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  upload_date: string | null;
  status: string;
  is_live: number;
  video_path: string | null;
  md_path: string | null;
  word_count: number;
  segment_index: number;
  start_seconds: number;
  end_seconds: number;
  text: string;
}

interface IndexStats {
  files: number;
  segments: number;
}

function formatUploadDate(uploadDate: string | null): string {
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

function buildSearchUrl(params: Record<string, string>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) searchParams.set(key, value);
  }
  return `/api/transcripts/search?${searchParams.toString()}`;
}

export default function TranscriptSearch() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("all");
  const [status, setStatus] = useState("complete");
  const [type, setType] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [results, setResults] = useState<TranscriptSearchResult[]>([]);
  const [searched, setSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [indexStats, setIndexStats] = useState<IndexStats>({ files: 0, segments: 0 });
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerSegmentIndex, setDrawerSegmentIndex] = useState<number | undefined>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { toast } = useToast();

  const resultCountByVideo = useMemo(() => {
    return new Set(results.map(result => `${result.channel_id}:${result.video_id}`)).size;
  }, [results]);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await apiRequest("GET", "/api/pipeline/config");
        const config = await response.json() as ConfigResponse;
        setChannels(config.channels || []);
        const statsResponse = await apiRequest("GET", `/api/transcripts/search/stats?t=${Date.now()}`);
        setIndexStats(await statsResponse.json() as IndexStats);
      } catch (error: any) {
        toast({ variant: "destructive", title: "Could not load channels", description: error.message });
      }
    };
    loadConfig();
  }, []);

  const runSearch = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setSearched(false);
      return;
    }

    setLoading(true);
    setSearched(true);
    try {
      const response = await apiRequest("GET", buildSearchUrl({
        q: trimmed,
        channelId,
        status,
        type,
        dateFrom: dateFrom.replaceAll("-", ""),
        dateTo: dateTo.replaceAll("-", ""),
        limit: "200",
        t: String(Date.now()),
      }));
      const data = await response.json() as { results: TranscriptSearchResult[]; index?: IndexStats };
      setResults(data.results || []);
      if (data.index) setIndexStats(data.index);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Search failed", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const response = await apiRequest("POST", "/api/transcripts/search/reindex");
      const data = await response.json();
      setIndexStats({ files: data.totalFiles || 0, segments: data.totalSegments || 0 });
      toast({
        title: "Transcript index refreshed",
        description: `${data.totalFiles || 0} files indexed, ${data.totalSegments || 0} segments searchable (${data.indexed || 0} updated)`,
      });
      if (query.trim()) await runSearch();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Reindex failed", description: error.message });
    } finally {
      setReindexing(false);
    }
  };

  const openDrawer = (result: TranscriptSearchResult) => {
    setDrawerVideo({
      video_id: result.video_id,
      channel_id: result.channel_id,
      channel_name: result.channel_name,
      title: result.title,
      upload_date: result.upload_date,
      status: result.status,
      is_live: result.is_live,
      video_path: result.video_path,
      md_path: result.md_path,
      word_count: result.word_count,
    });
    setDrawerSeconds(result.start_seconds);
    setDrawerSegmentIndex(result.segment_index);
    setDrawerOpen(true);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="flex items-center gap-2">
              <SearchIcon className="h-4 w-4" />
              Transcript Search
            </CardTitle>
            <Button size="sm" variant="outline" onClick={reindex} disabled={reindexing}>
              {reindexing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <DatabaseZap className="h-4 w-4 mr-1" />}
              Reindex
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(240px,1fr)_180px_150px_140px_150px_150px_auto]">
            <div className="relative">
              <SearchIcon className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => { if (event.key === "Enter") runSearch(); }}
                placeholder="Search spoken words"
                className="h-9 pl-8"
              />
            </div>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                {channels.map(channel => <SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="complete">Complete</SelectItem>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
              </SelectContent>
            </Select>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="video">Videos</SelectItem>
                <SelectItem value="live">Lives</SelectItem>
              </SelectContent>
            </Select>
            <Input type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} className="h-9" />
            <Input type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} className="h-9" />
            <Button onClick={runSearch} disabled={loading || !query.trim()} className="h-9">
              {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <SearchIcon className="h-4 w-4 mr-1" />}
              Search
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="secondary">{results.length} matching segments</Badge>
            <Badge variant="outline">{resultCountByVideo} videos</Badge>
            <Badge variant="outline">{indexStats.files} indexed files</Badge>
            <Badge variant="outline">{indexStats.segments} indexed segments</Badge>
            <Badge variant="outline" className="gap-1"><Clock className="h-3 w-3" /> timestamps included</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <FileText className="h-4 w-4" />
            Results
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y rounded-md border">
            {results.map(result => (
              <div key={`${result.channel_id}:${result.video_id}:${result.segment_index}`} className="p-3 text-sm">
                <div className="flex flex-col gap-1 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{result.title}</div>
                    <div className="text-xs text-muted-foreground flex flex-wrap gap-x-2 gap-y-1 mt-1">
                      <span>{result.channel_name || result.channel_id}</span>
                      <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{formatUploadDate(result.upload_date)}</span>
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatTimestamp(result.start_seconds)} - {formatTimestamp(result.end_seconds)}</span>
                      {!!result.is_live && <span className="flex items-center gap-1"><Radio className="h-3 w-3" />Live</span>}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-wrap md:justify-end">
                    <Badge variant="outline">{result.status}</Badge>
                    {result.word_count > 0 && <Badge variant="outline">{result.word_count} words</Badge>}
                  </div>
                </div>
                <p className="mt-2 leading-6 text-sm">{result.text}</p>
                <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground font-mono">
                    {result.md_path && <span>{result.md_path}</span>}
                    {result.video_path && <span>{result.video_path}</span>}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!result.video_path}
                    onClick={() => openDrawer(result)}
                    className="h-8 w-fit whitespace-nowrap"
                  >
                    <Play className="h-3 w-3" />
                    Open at {formatTimestamp(result.start_seconds)}
                  </Button>
                </div>
              </div>
            ))}
            {searched && !loading && results.length === 0 && (
              <p className="text-xs text-muted-foreground p-3">No transcript segments matched this search.</p>
            )}
            {!searched && (
              <p className="text-xs text-muted-foreground p-3">Search for words or phrases spoken in transcripts.</p>
            )}
          </div>
        </CardContent>
      </Card>
      <VideoDrawer
        open={drawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
        initialSegmentIndex={drawerSegmentIndex}
        onOpenChange={setDrawerOpen}
      />
    </div>
  );
}
