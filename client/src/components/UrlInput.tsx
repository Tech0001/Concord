import { useState, FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { VideoInfo } from "@/types/video";

interface UrlInputProps {
  onVideoFetched: (videoData: VideoInfo) => void;
  onLoading: (isLoading: boolean) => void;
  onError: (error: string) => void;
}

export default function UrlInput({ onVideoFetched, onLoading, onError }: UrlInputProps) {
  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const { toast } = useToast();

  /** Pull an 11-char YouTube video ID out of any of the common URL
   *  shapes — mobile (m.), shorts, live, embed, watch, youtu.be,
   *  music subdomain, anything-else.youtube.com — plus a bare ID
   *  pasted on its own. Returns null when nothing looks like a
   *  YouTube ID. */
  const extractYouTubeVideoId = (raw: string): string | null => {
    const input = raw.trim();
    if (!input) return null;
    // Bare 11-char ID (someone copied just the ID).
    if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
    // Path-based extraction. Tolerates extra query params (timestamps,
    // playlists, share trackers) and subdomains (m., music., gaming.).
    const patterns = [
      /(?:youtube\.com|youtu\.be|youtube-nocookie\.com)\/watch\?(?:[^#]*&)?v=([a-zA-Z0-9_-]{11})/i,
      /(?:youtube\.com|youtube-nocookie\.com)\/shorts\/([a-zA-Z0-9_-]{11})/i,
      /(?:youtube\.com|youtube-nocookie\.com)\/live\/([a-zA-Z0-9_-]{11})/i,
      /(?:youtube\.com|youtube-nocookie\.com)\/embed\/([a-zA-Z0-9_-]{11})/i,
      /(?:youtube\.com|youtube-nocookie\.com)\/v\/([a-zA-Z0-9_-]{11})/i,
      /youtu\.be\/([a-zA-Z0-9_-]{11})/i,
    ];
    for (const re of patterns) {
      const m = input.match(re);
      if (m) return m[1];
    }
    return null;
  };

  const handleUrlSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setUrlError(null);

    if (!urlInput.trim()) {
      setUrlError("Please enter a YouTube URL");
      return;
    }

    // Normalize to canonical /watch?v= form before sending to the
    // server so yt-dlp never sees the m. / shorts / live / embed
    // variants directly. yt-dlp handles them anyway, but normalizing
    // here also doubles as validation — if we can't extract an ID,
    // it's not a YouTube link we know how to handle.
    const videoId = extractYouTubeVideoId(urlInput);
    if (!videoId) {
      setUrlError("Couldn't find a YouTube video ID in that URL. Supported: watch, youtu.be, shorts, live, embed, m. (mobile), or just paste the 11-char ID.");
      return;
    }
    const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

    onLoading(true);

    try {
      const res = await apiRequest("POST", "/api/videos/info", { url: canonicalUrl });
      const data = await res.json();

      if (data.error) {
        throw new Error(data.error);
      }

      onVideoFetched(data);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to fetch video information";
      onError(errorMessage);
      toast({
        variant: "destructive",
        title: "Error",
        description: errorMessage,
      });
    } finally {
      onLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Download a single video</CardTitle>
        <p id="single-video-help" className="text-xs text-muted-foreground">Paste a YouTube video link to preview, download, and transcribe it. This does not subscribe to the channel.</p>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleUrlSubmit}>
          <label htmlFor="youtube-url" className="text-xs font-medium text-muted-foreground">
            YouTube video URL
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="youtube-url"
              type="text"
              placeholder="https://www.youtube.com/watch?v=… or https://youtu.be/…"
              aria-describedby="single-video-help"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm">
              Preview video
            </Button>
          </div>
          {urlError && (
            <p className="mt-2 text-xs text-destructive">
              {urlError}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
