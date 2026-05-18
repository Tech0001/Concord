import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Compass, Download, Loader2, Plus, Search as SearchIcon, ExternalLink } from "lucide-react";

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
  const [order, setOrder] = useState<"relevance" | "date">("relevance");
  const [loading, setLoading] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [downloading, setDownloading] = useState<Record<string, boolean>>({});

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await apiRequest("GET", `/api/youtube/search?q=${encodeURIComponent(q)}&order=${order}`);
      const data = await res.json() as { hits?: SearchHit[]; error?: string };
      if (data.error) throw new Error(data.error);
      setHits(data.hits ?? []);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Search failed", description: err.message });
    } finally {
      setLoading(false);
    }
  };

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
            <div className="flex gap-2">
              <Button
                variant={order === "relevance" ? "default" : "outline"}
                size="sm"
                onClick={() => setOrder("relevance")}
              >Relevance</Button>
              <Button
                variant={order === "date" ? "default" : "outline"}
                size="sm"
                onClick={() => setOrder("date")}
              >Date</Button>
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

      {!loading && hits.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Try a quoted phrase that captures the relationship you care about, e.g.
          {" "}<code>"interview with Jane Doe"</code> or <code>"with John Smith"</code>.
        </p>
      )}
    </div>
  );
}
