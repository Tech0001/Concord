import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Compass, Download, Loader2, Plus, Search as SearchIcon, ExternalLink } from "lucide-react";

type SearchOrder = "relevance" | "date" | "viewCount" | "rating" | "title";

const ORDER_OPTIONS: { value: SearchOrder; label: string }[] = [
  { value: "relevance", label: "Most relevant" },
  { value: "date",      label: "Newest first" },
  { value: "viewCount", label: "Most viewed" },
  { value: "rating",    label: "Top rated" },
  { value: "title",     label: "Title A→Z" },
];

interface SearchHit {
  videoId: string;
  channelId: string;
  channelName: string | null;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
}

/**
 * /discover — one-off YouTube searches via the user's Data API key.
 * Hits land here for review; the user clicks "Download" to send a
 * specific video into the existing video_queue, or "Save as watcher"
 * to promote the current query into a recurring saved search.
 */
export default function Discover() {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<SearchOrder>("relevance");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});

  // `append` distinguishes "fresh search" (replace) from "Load more"
  // (append). YouTube's pagination is opaque page tokens, so we feed
  // back whatever the server returned without inspecting it.
  const fetchPage = async (pageToken: string | null, append: boolean) => {
    const q = query.trim();
    if (!q) return;
    const setBusy = append ? setLoadingMore : setLoading;
    setBusy(true);
    try {
      const params = new URLSearchParams({ q, order });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await apiRequest("GET", `/api/youtube/search?${params.toString()}`);
      const data = await res.json() as { hits?: SearchHit[]; nextPageToken?: string | null; error?: string };
      if (data.error) throw new Error(data.error);
      setHits(prev => append ? [...prev, ...(data.hits ?? [])] : (data.hits ?? []));
      setNextPageToken(data.nextPageToken ?? null);
    } catch (err: any) {
      toast({ variant: "destructive", title: append ? "Load more failed" : "Search failed", description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const runSearch = () => fetchPage(null, false);
  const loadMore = () => fetchPage(nextPageToken, true);

  const queueDownload = async (hit: SearchHit) => {
    setDownloading(s => ({ ...s, [hit.videoId]: true }));
    try {
      await apiRequest("POST", "/api/videos/download", {
        url: `https://www.youtube.com/watch?v=${hit.videoId}`,
      });
      toast({ title: "Download queued", description: hit.title });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Queue failed", description: err.message });
    } finally {
      setDownloading(s => ({ ...s, [hit.videoId]: false }));
    }
  };

  const saveAsWatcher = async () => {
    const q = query.trim();
    if (!q) return;
    try {
      await apiRequest("POST", "/api/youtube/watchers", {
        label: q,
        phrase_variants: [q],
        enabled: true,
        auto_queue: false,
        poll_interval_hours: 24,
      });
      toast({
        title: "Watcher saved",
        description: `"${q}" will be polled daily — edit it on the Watchers page.`,
      });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Save failed", description: err.message });
    }
  };

  return (
    <div className="px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Compass className="h-4 w-4" />
            Discover
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='e.g. "with John Smith" or "interview with Jane Doe"'
              onKeyDown={(e) => { if (e.key === "Enter") void runSearch(); }}
              className="flex-1"
            />
            <div className="flex flex-wrap gap-2">
              <Select value={order} onValueChange={(v) => setOrder(v as SearchOrder)}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ORDER_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button onClick={runSearch} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <SearchIcon className="h-4 w-4" />}
                Search
              </Button>
              <Button variant="outline" onClick={saveAsWatcher} disabled={!query.trim()}>
                <Plus className="h-4 w-4" />
                Save as watcher
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Uses your YouTube Data API key (Settings → YouTube Data API).
            Each search costs 100 quota units; the free tier is 10,000/day (~100 searches).
          </p>
        </CardContent>
      </Card>

      {hits.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {hits.map((hit) => (
            <Card key={hit.videoId} className="overflow-hidden">
              {hit.thumbnailUrl && (
                <a
                  href={`https://www.youtube.com/watch?v=${hit.videoId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="block bg-muted"
                >
                  <img src={hit.thumbnailUrl} alt="" className="w-full h-auto" />
                </a>
              )}
              <CardContent className="space-y-2 p-3 text-sm">
                <p className="line-clamp-2 font-medium leading-snug">{hit.title}</p>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span>{hit.channelName ?? hit.channelId}</span>
                  {hit.publishedAt && <span>· {hit.publishedAt.slice(0, 10)}</span>}
                </div>
                {hit.description && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{hit.description}</p>
                )}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    onClick={() => queueDownload(hit)}
                    disabled={downloading[hit.videoId]}
                    className="flex-1"
                  >
                    {downloading[hit.videoId]
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : <Download className="h-3.5 w-3.5" />}
                    Download
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    asChild
                  >
                    <a
                      href={`https://www.youtube.com/watch?v=${hit.videoId}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {hits.length > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{hits.length} result{hits.length === 1 ? "" : "s"} loaded</span>
          {nextPageToken && (
            <Button size="sm" variant="outline" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Load more
            </Button>
          )}
        </div>
      )}

      {!loading && hits.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Try a quoted phrase that captures the relationship you care about, e.g.
          {" "}<code>"interview with Jane Doe"</code> or <code>"with John Smith"</code>.
        </p>
      )}
    </div>
  );
}
