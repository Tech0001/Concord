import { useState, FormEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

  const validateYouTubeUrl = (url: string) => {
    const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})(\S*)?$/;
    return youtubeRegex.test(url);
  };

  const handleUrlSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setUrlError(null);

    if (!urlInput.trim()) {
      setUrlError("Please enter a YouTube URL");
      return;
    }

    if (!validateYouTubeUrl(urlInput)) {
      setUrlError("Please enter a valid YouTube URL");
      return;
    }

    onLoading(true);

    try {
      const res = await apiRequest("POST", "/api/videos/info", { url: urlInput });
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
      <CardContent className="pt-4">
        <form onSubmit={handleUrlSubmit}>
          <label htmlFor="youtube-url" className="text-xs font-medium text-muted-foreground">
            YouTube URL
          </label>
          <div className="mt-1.5 flex gap-2">
            <Input
              id="youtube-url"
              type="text"
              placeholder="https://www.youtube.com/watch?v=..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="flex-1 font-mono text-xs"
            />
            <Button type="submit" size="sm">
              Fetch
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
