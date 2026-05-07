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

    // Reset states
    setUrlError(null);
    
    // Validate URL format
    if (!urlInput.trim()) {
      setUrlError("Please enter a YouTube URL");
      return;
    }

    if (!validateYouTubeUrl(urlInput)) {
      setUrlError("Please enter a valid YouTube URL");
      return;
    }

    // Set loading state and fetch video info
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
    <Card className="mb-6">
      <CardContent className="p-6">
        <form onSubmit={handleUrlSubmit} className="flex flex-col">
          <label htmlFor="youtube-url" className="text-sm font-medium text-gray-600 mb-2">
            YouTube Video URL
          </label>
          <div className="flex items-center">
            <Input
              id="youtube-url"
              type="text"
              placeholder="https://www.youtube.com/watch?v=..."
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              className="rounded-r-none"
            />
            <Button 
              type="submit" 
              className="bg-[#FF0000] hover:bg-red-700 text-white rounded-l-none px-6"
            >
              Fetch
            </Button>
          </div>
          {urlError && (
            <div className="mt-2 text-red-500 text-sm">
              {urlError}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
