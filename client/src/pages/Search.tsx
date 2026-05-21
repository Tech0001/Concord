import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagPicker } from "@/components/TagPicker";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { useToast } from "@/hooks/use-toast";
import { useCategory } from "@/hooks/use-category";
import { apiRequest } from "@/lib/queryClient";
import { Calendar, ChevronDown, Clock, DatabaseZap, FileText, Filter, Loader2, Play, Radio, Search as SearchIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

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
  speaker: string | null;
  text: string;
  /** Cosine similarity for semantic results; absent for FTS results. */
  score?: number;
}

interface IndexStats {
  files: number;
  segments: number;
}

interface TagOption {
  tag: string;
  count: number;
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
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [speakerFilter, setSpeakerFilter] = useState("all");
  const [speakerOptions, setSpeakerOptions] = useState<{ id: string; name: string }[]>([]);
  // Search mode: "words" hits the FTS5 index (exact tokens, fast).
  // "meaning" embeds the query and cosine-ranks against the embedding store
  // (semantic — finds conceptually-related segments without literal overlap).
  const [mode, setMode] = useState<"words" | "meaning">("words");
  const [embeddingStats, setEmbeddingStats] = useState<{ totalSegments: number; totalVideos: number } | null>(null);
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerSegmentIndex, setDrawerSegmentIndex] = useState<number | undefined>();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { toast } = useToast();
  const { serverCategory } = useCategory();

  const resultCountByVideo = useMemo(() => {
    return new Set(results.map(result => `${result.channel_id}:${result.video_id}`)).size;
  }, [results]);

  const loadTagOptions = async () => {
    try {
      const response = await apiRequest("GET", `/api/clips/tags?t=${Date.now()}`);
      const data = await response.json() as { tags?: TagOption[] };
      setTagOptions(data.tags || []);
    } catch {
      setTagOptions([]);
    }
  };

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const response = await apiRequest("GET", "/api/pipeline/config");
        const config = await response.json() as ConfigResponse;
        setChannels(config.channels || []);
        const statsResponse = await apiRequest("GET", `/api/transcripts/search/stats?t=${Date.now()}`);
        setIndexStats(await statsResponse.json() as IndexStats);
        await loadTagOptions();
        try {
          const sres = await apiRequest("GET", "/api/speakers");
          const sdata = await sres.json();
          // Hide noise speakers from the search filter — you wouldn't
          // want to filter results down to "show me everywhere there
          // was background music."
          setSpeakerOptions((sdata.speakers || []).filter((s: any) => s.is_noise !== 1).map((s: any) => ({ id: s.id, name: s.name })));
        } catch { setSpeakerOptions([]); }
        // Embedding stats — used by the Mode toggle to warn when Meaning
        // mode is selected but nothing has been embedded yet.
        try {
          const r = await apiRequest("GET", "/api/llm/embeddings/stats");
          const s = await r.json();
          setEmbeddingStats({ totalSegments: s.totalSegments || 0, totalVideos: s.totalVideos || 0 });
        } catch { /* AI page might not be configured yet — fine */ }
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
      if (mode === "meaning") {
        const response = await apiRequest("POST", "/api/transcripts/search-semantic", {
          query: trimmed,
          limit: 200,
          filters: {
            channelId,
            status,
            isLive: type === "live" ? true : type === "video" ? false : undefined,
            dateFrom: dateFrom ? dateFrom.replaceAll("-", "") : undefined,
            dateTo: dateTo ? dateTo.replaceAll("-", "") : undefined,
            tags: tagFilter,
            speakerId: speakerFilter === "all" ? undefined : speakerFilter,
            category: serverCategory || undefined,
          },
        });
        const data = await response.json() as { results: TranscriptSearchResult[] };
        setResults(data.results || []);
      } else {
        const response = await apiRequest("GET", buildSearchUrl({
          q: trimmed,
          channelId,
          status,
          type,
          dateFrom: dateFrom.replaceAll("-", ""),
          dateTo: dateTo.replaceAll("-", ""),
          tags: tagFilter.join(","),
          speakerId: speakerFilter === "all" ? "" : speakerFilter,
          category: serverCategory,
          limit: "200",
          t: String(Date.now()),
        }));
        const data = await response.json() as { results: TranscriptSearchResult[]; index?: IndexStats };
        setResults(data.results || []);
        if (data.index) setIndexStats(data.index);
      }
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
        <CardHeader className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <SearchIcon className="h-4 w-4" />
              Search
            </CardTitle>
            <Button size="sm" variant="outline" onClick={reindex} disabled={reindexing}>
              {reindexing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <DatabaseZap className="h-4 w-4 mr-1" />}
              Reindex
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {/* Primary row: search input (with Words/Meaning toggle), channel,
              filters popover, search button. Secondary filters (status, type,
              date range, tag scope, speaker) live behind "More filters" so
              the toolbar stays scannable. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex flex-1 min-w-[280px] gap-1">
              <div className="relative flex-1">
                <SearchIcon className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") runSearch(); }}
                  placeholder={mode === "meaning" ? "Describe what you're looking for…" : "Search spoken words"}
                  className="h-9 pl-8"
                />
              </div>
              <div className="inline-flex h-9 items-center rounded-md border bg-muted/40 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setMode("words")}
                  className={`h-full rounded-sm px-2.5 transition-colors ${mode === "words" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  title="Exact word matching — FTS5 keyword search"
                >
                  Words
                </button>
                <button
                  type="button"
                  onClick={() => setMode("meaning")}
                  className={`h-full rounded-sm px-2.5 transition-colors ${mode === "meaning" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  title="Semantic search by meaning — embedding similarity"
                >
                  Meaning
                </button>
              </div>
            </div>
            <Select value={channelId} onValueChange={setChannelId}>
              <SelectTrigger className="h-9 w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                {channels.map(channel => <SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {(() => {
              const activeFilterCount =
                (status !== "complete" ? 1 : 0) +
                (type !== "all" ? 1 : 0) +
                (dateFrom ? 1 : 0) +
                (dateTo ? 1 : 0) +
                (tagFilter.length > 0 ? 1 : 0) +
                (speakerFilter !== "all" ? 1 : 0);
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
                  <PopoverContent className="w-80 space-y-2 p-3" align="end">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="col-span-1 space-y-1">
                        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</label>
                        <Select value={status} onValueChange={setStatus}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="complete">Complete</SelectItem>
                            <SelectItem value="all">All statuses</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                            <SelectItem value="pending">Pending</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="col-span-1 space-y-1">
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
                      <div className="col-span-1 space-y-1">
                        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Date from</label>
                        <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 text-xs" />
                      </div>
                      <div className="col-span-1 space-y-1">
                        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Date to</label>
                        <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 text-xs" />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Tag scope</label>
                      <TagPicker
                        value={tagFilter}
                        onChange={setTagFilter}
                        options={tagOptions}
                        size="sm"
                        placeholder="Pick note tags..."
                        onOpen={loadTagOptions}
                      />
                      {tagFilter.length > 0 && (
                        <p className="text-[10px] text-muted-foreground">
                          Restricts to videos with at least one note tagged with every selection.
                        </p>
                      )}
                    </div>
                    {speakerOptions.length > 0 && (
                      <div className="space-y-1">
                        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Speaker</label>
                        <Select value={speakerFilter} onValueChange={setSpeakerFilter}>
                          <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">Anyone</SelectItem>
                            {speakerOptions.map((s) => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {activeFilterCount > 0 && (
                      <div className="flex justify-end pt-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => {
                            setStatus("complete"); setType("all");
                            setDateFrom(""); setDateTo("");
                            setTagFilter([]); setSpeakerFilter("all");
                          }}
                        >
                          Clear all
                        </Button>
                      </div>
                    )}
                  </PopoverContent>
                </Popover>
              );
            })()}
            <Button onClick={runSearch} disabled={loading || !query.trim()} className="h-9">
              {loading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <SearchIcon className="h-4 w-4 mr-1" />}
              Search
            </Button>
          </div>

          {/* Mode hint — terse, only when it adds value. */}
          {mode === "meaning" && (!embeddingStats || embeddingStats.totalSegments === 0) && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              No embeddings yet — run <strong>Reindex semantics</strong> on the <a href="/settings" className="underline">Settings page</a> first.
            </p>
          )}

          {/* One compact stats line. Hover for index breakdown if curious. */}
          <div
            className="text-xs text-muted-foreground"
            title={`${indexStats.files} indexed files · ${indexStats.segments} indexed segments`}
          >
            {results.length} {results.length === 1 ? "match" : "matches"}
            {resultCountByVideo > 0 && <> · across {resultCountByVideo} {resultCountByVideo === 1 ? "video" : "videos"}</>}
            {mode === "meaning" && embeddingStats && embeddingStats.totalSegments > 0 && (
              <> · searching {embeddingStats.totalSegments.toLocaleString()} embedded segments</>
            )}
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
                <p className="mt-2 leading-6 text-sm">
                  {result.speaker && (
                    <span className="mr-1.5 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground">
                      {result.speaker}
                    </span>
                  )}
                  {typeof result.score === "number" && (
                    <span
                      className={`mr-1.5 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold ${
                        result.score >= 0.7
                          ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400"
                          : result.score >= 0.55
                            ? "bg-foreground/10 text-foreground"
                            : "bg-muted text-muted-foreground"
                      }`}
                      title="Cosine similarity to your query (1.0 = identical, 0 = unrelated)"
                    >
                      {result.score.toFixed(2)}
                    </span>
                  )}
                  {result.text}
                </p>
                <div className="mt-2 flex items-center justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!result.video_path}
                    onClick={() => openDrawer(result)}
                    className="h-8 w-fit whitespace-nowrap"
                    title={result.video_path ? `${result.video_path}\n${result.md_path ?? ""}` : "No saved video file for this record"}
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
