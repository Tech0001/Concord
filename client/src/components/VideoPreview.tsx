import { useState, useEffect } from "react";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { apiRequest } from "@/lib/queryClient";
import { VideoInfo, VideoFormat } from "@/types/video";
import { useToast } from "@/hooks/use-toast";
import { DownloadIcon, ClockIcon, EyeIcon, CheckCircle, FolderCheck, FileText, Loader2 } from "lucide-react";

function transcribeJobLabel(status: string): string {
  switch (status) {
    case "extracting_audio": return "Extracting audio…";
    case "transcribing":     return "Transcribing on Apple Neural Engine…";
    case "saving_md":        return "Saving transcript…";
    case "downloading":      return "Downloading…";
    default:                 return status.replace(/_/g, " ") + "…";
  }
}

interface VideoPreviewProps {
  videoData: VideoInfo;
  downloadProgress: number;
  isDownloading: boolean;
  setIsDownloading: (isDownloading: boolean) => void;
  updateDownloadProgress: (progress: number) => void;
  /** Server-configured save directory (Pipeline → Settings → Video save). Empty = save to temp + show "Save to your computer" prompt. */
  downloadLocation: string;
  /** If true, shows a "Transcribe" button after download completes */
  showTranscribe?: boolean;
  /** Called when user clicks Transcribe after download */
  onTranscribe?: (
    filePath: string,
    videoTitle: string,
    uploadDate?: string | null,
    videoId?: string,
    channelId?: string | null,
    channelName?: string | null,
  ) => void;
  /** In-flight transcription job for THIS video, if any. Lets us show
   *  inline progress instead of forcing the user to scroll to the global
   *  jobs list. Pass null when no transcribe is in flight. */
  transcribeJob?: { status: string; progress: number; error?: string } | null;
  /** Personal / work category for the resulting video_queue row. The
   *  Pipeline page passes the header toggle in; orphan downloads
   *  default to 'personal' server-side. */
  downloadCategory?: "personal" | "work";
}

export default function VideoPreview({
  videoData,
  downloadProgress,
  isDownloading,
  setIsDownloading,
  updateDownloadProgress,
  downloadLocation,
  showTranscribe = false,
  onTranscribe,
  transcribeJob,
  downloadCategory,
}: VideoPreviewProps) {
  const [selectedResolution, setSelectedResolution] = useState("");
  const [selectedFormat, setSelectedFormat] = useState<VideoFormat | null>(null);
  const [showProgress, setShowProgress] = useState(false);
  const [downloadComplete, setDownloadComplete] = useState(false);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [finalFilePath, setFinalFilePath] = useState<string | null>(null);
  const [wasSavedToCustom, setWasSavedToCustom] = useState(false);
  const { toast } = useToast();

  // Set initial resolution when video data loads
  useEffect(() => {
    if (videoData && videoData.formats && videoData.formats.length > 0) {
      // Get all MP4 formats with a resolution
      const mp4Formats = videoData.formats.filter(format => 
        format.ext === "mp4" && format.resolution
      );
      
      let bestFormat;
      
      // First try to find 720p format as a good default balance of quality and size
      bestFormat = mp4Formats.find(format => format.resolution?.includes("720"));
      
      // If no 720p, try 480p
      if (!bestFormat) {
        bestFormat = mp4Formats.find(format => format.resolution?.includes("480"));
      }
      
      // If still no match, try any mp4 with resolution
      if (!bestFormat && mp4Formats.length > 0) {
        bestFormat = mp4Formats[0];
      }
      
      // Last resort, use any format
      if (!bestFormat) {
        bestFormat = videoData.formats[0];
      }
      
      // Set the selected resolution
      setSelectedResolution(bestFormat.format_id);
      setSelectedFormat(bestFormat);
      
      console.log(`Selected format: ${bestFormat.format_id} - ${bestFormat.resolution || "Unknown"} (${bestFormat.ext})`);
    }
  }, [videoData]);

  useEffect(() => {
    if (videoData && videoData.formats) {
      const format = videoData.formats.find(f => f.format_id === selectedResolution);
      if (format) {
        setSelectedFormat(format);
      }
    }
  }, [selectedResolution, videoData]);

  const handleResolutionChange = (value: string) => {
    setSelectedResolution(value);
  };

  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return "Unknown size";
    
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    if (bytes === 0) return "0 Byte";
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + " " + sizes[i];
  };

  const startDownloadEventSource = (downloadId: string) => {
    const eventSource = new EventSource(`/api/videos/download-progress/${downloadId}`);
    let progressTimeout: NodeJS.Timeout | null = null;
    let stuckCounter = 0;
    
    // Reset progress timeout
    const resetProgressTimeout = () => {
      if (progressTimeout) {
        clearTimeout(progressTimeout);
      }
      
      // If we're stuck at 0% for more than 30 seconds, show a helpful message
      progressTimeout = setTimeout(() => {
        if (stuckCounter >= 5) {
          toast({
            title: "Still working",
            description: "The download is taking longer than expected. Please be patient...",
            duration: 5000,
          });
        }
        stuckCounter++;
      }, 6000); // Check every 6 seconds
    };
    
    // Start initial timeout
    resetProgressTimeout();
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("EventSource data:", data);
        
        // Handle potential errors from server
        if (data.percent === -1 && data.error) {
          console.error("Server reported download error:", data.error);
          toast({
            variant: "destructive",
            title: "Download Failed",
            description: data.error,
            duration: 7000,
          });
          eventSource.close();
          if (progressTimeout) clearTimeout(progressTimeout);
          setIsDownloading(false);
          setShowProgress(false);
          setDownloadComplete(false); // Ensure it's marked as not complete
          setDownloadId(null);
          return;
        }
        
        // If we get a non-zero progress, reset the stuck counter
        if (data.percent > 0) {
          stuckCounter = 0;
        }
        
        // Reset timeout since we received a message
        resetProgressTimeout();
        
        // Update the progress
        updateDownloadProgress(data.percent);
        
        // Check for completion event
        if (data.completed && data.percent >= 100) {
          console.log("Download completed event received:", data);
          eventSource.close();
          
          if (progressTimeout) {
            clearTimeout(progressTimeout);
          }
          
          // Update state after a short delay
          setTimeout(() => {
            setIsDownloading(false);
            setShowProgress(false);
            setDownloadComplete(true);
            setDownloadId(downloadId);
            setFileName(data.fileName || 'youtube-video.mp4');
            setFinalFilePath(data.finalPath || null);
            setWasSavedToCustom(data.savedToCustom || false);
            
            console.log("Updated download state:", { 
              downloadComplete: true, 
              downloadId,
              fileName: data.fileName,
              finalPath: data.finalPath,
              savedToCustom: data.savedToCustom
            });
            
            if (data.savedToCustom && data.finalPath) {
              toast({
                title: "Download Complete",
                description: `Video saved to: ${data.finalPath}`,
                duration: 7000,
              });
            } else {
              toast({
                title: "Processing complete",
                description: "Your video is ready to download. Click the button below.",
                duration: 5000,
              });
            }
          }, 300);
        }
      } catch (error) {
        console.error("Error parsing event data:", error);
      }
    };
    
    eventSource.onerror = () => {
      console.error("EventSource error occurred");
      eventSource.close();
      
      // Clear any pending timeouts
      if (progressTimeout) {
        clearTimeout(progressTimeout);
      }
      
      setIsDownloading(false);
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to receive download progress updates.",
      });
    };
    
    return eventSource;
  };

  const handleSaveToComputer = () => {
    if (!downloadId) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Download ID is missing. Please try downloading again.",
      });
      return;
    }
    
    // Log the download attempt
    console.log(`Initiating file download for ID: ${downloadId}, filename: ${fileName || 'youtube-video.mp4'}`);
    
    // Create the download URL with the specific download ID
    const downloadUrl = `/api/videos/download/${downloadId}`;
    
    // Show a toast to inform user the download is starting
    toast({
      title: "Starting download",
      description: "Preparing your file...",
    });
    
    // Use fetch to check if the file is available first
    fetch(downloadUrl, { method: 'HEAD' })
      .then(async response => {
        if (!response.ok) {
          // Try to get more detailed error information
          let errorMsg = `Server returned ${response.status}: ${response.statusText}`;
          
          try {
            // Attempt to parse JSON error message
            const errorData = await response.json();
            if (errorData && errorData.error) {
              errorMsg = errorData.error;
            }
          } catch (e) {
            // If we can't parse JSON, just use the default error message
          }
          
          throw new Error(errorMsg);
        }
        
        // File exists and is accessible, proceed with GET request
        return fetch(downloadUrl);
      })
      .then(async response => {
        // Check if this is a JSON response (for custom location files)
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await response.json();
          
          // If file is already saved in custom location
          if (data.alreadySaved && data.path) {
            toast({
              title: "File saved",
              description: `Your video has been saved to: ${data.path}`,
              duration: 7000,
            });
            
            // Reset download state
            setTimeout(() => {
              setDownloadComplete(false);
              setDownloadId(null);
              setFileName(null);
            }, 1000);
            
            return; // Don't need to download
          }
        }
        
        // Otherwise trigger browser download (for temp files)
        const link = document.createElement('a');
        link.href = downloadUrl;
        // We let the server set the filename via Content-Disposition header
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Only reset download state after successfully starting the download
        setTimeout(() => {
          setDownloadComplete(false);
          setDownloadId(null);
          setFileName(null);
        }, 1000);
      })
      .catch(error => {
        console.error("Error downloading file:", error);
        toast({
          variant: "destructive",
          title: "Download failed",
          description: error.message || "Failed to download the file. Please try again.",
        });
      });
  };
  
  const handleDownload = async () => {
    if (!selectedFormat) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "No format selected. Please select a video quality first.",
      });
      return;
    }
    
    try {
      setIsDownloading(true);
      setShowProgress(true);
      
      // Reset progress and completion status
      updateDownloadProgress(0);
      setDownloadComplete(false);
      
      // Send download request with format and download location
      const downloadBody: any = {
        videoId: videoData.id,
        formatId: selectedFormat.format_id,
        downloadLocation,
        // Optional category override — VideoPreview is consumed from
        // the Pipeline page (which passes it via prop) so the row
        // lands in the right Library section without extra clicks.
        category: downloadCategory,
      };

      // Pipeline mode: pass extra params for channel folder + date prefix
      if (showTranscribe) {
        downloadBody.uploadDate = videoData.uploadDate;
        downloadBody.channelId = videoData.channelId;
        downloadBody.channelName = videoData.channelName;
      }

      const response = await apiRequest("POST", "/api/videos/download", downloadBody);
      
      const data = await response.json();
      
      if (data.error) {
        // Check for specific error about download location
        if (data.error.includes("Cannot access or create the specified download location")) {
          toast({
            variant: "destructive",
            title: "Invalid Download Location",
            description: "The specified folder can't be accessed or created. Please choose a different location in the Download Settings.",
            duration: 7000,
          });
          
          // Fall back to temp directory if provided
          if (data.fallbackPath) {
            toast({
              title: "Using Temporary Location",
              description: "Your video will be downloaded to a temporary location instead. You'll need to save it to your computer when finished.",
              duration: 5000,
            });
            
            const retryBody: any = {
              videoId: videoData.id,
              formatId: selectedFormat.format_id,
              category: downloadCategory,
            };
            if (showTranscribe) {
              retryBody.uploadDate = videoData.uploadDate;
              retryBody.channelId = videoData.channelId;
              retryBody.channelName = videoData.channelName;
            }
            // Continue with download using fallback path
            const retryResponse = await apiRequest("POST", "/api/videos/download", retryBody);
            
            const retryData = await retryResponse.json();
            if (retryData.error) {
              throw new Error(retryData.error);
            }
            
            if (retryData.downloadId) {
              setDownloadId(retryData.downloadId);
              const eventSource = startDownloadEventSource(retryData.downloadId);
              
              // Clean up event source when component unmounts
              return () => {
                eventSource.close();
              };
            }
            
            return;
          }
        }
        
        throw new Error(data.error);
      }
      
      if (data.downloadId) {
        setDownloadId(data.downloadId);
        const eventSource = startDownloadEventSource(data.downloadId);
        
        // Clean up event source when component unmounts
        return () => {
          eventSource.close();
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to start download";
      toast({
        variant: "destructive",
        title: "Download Error",
        description: errorMessage,
      });
      setIsDownloading(false);
      setShowProgress(false);
    }
  };

  if (!videoData) return null;

  return (
    <Card className="overflow-hidden">
      <div className="md:flex">
        <div className="md:w-2/5">
          <img
            src={videoData.thumbnail}
            alt={videoData.title}
            className="aspect-video w-full object-cover md:aspect-auto md:h-full"
          />
        </div>
        <div className="flex-1 p-4 md:w-3/5">
          <h2 className="text-base font-semibold leading-snug">
            {videoData.title}
          </h2>
          <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <EyeIcon className="h-3.5 w-3.5" />
              {videoData.views}
            </span>
            <span className="inline-flex items-center gap-1">
              <ClockIcon className="h-3.5 w-3.5" />
              {videoData.duration}
            </span>
          </div>

          <div className="mt-4">
            <label htmlFor="resolution" className="text-xs font-medium text-muted-foreground">
              Resolution
            </label>
            <div className="mt-1.5">
              <Select value={selectedResolution} onValueChange={handleResolutionChange}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select resolution" />
                </SelectTrigger>
                <SelectContent>
                  {videoData.formats
                    .filter(format => {
                      if (format.ext === "mp4" && format.resolution) return true;
                      if (format.ext === "m4a" && !format.resolution) return true;
                      return format.format_id && (format.ext === "mp4" || format.ext === "webm");
                    })
                    .map(format => {
                      // Surface the audio-track language so the user
                      // can pick the right one on multi-language
                      // videos. yt-dlp gives us either `language`
                      // (ISO 639-1) or a richer `format_note`
                      // ("English original", "Spanish (Latin
                      // America)"). Prefer the note when available
                      // — it disambiguates dialect / role variants
                      // that the bare code can't.
                      const hasAudio = format.acodec && format.acodec !== "none";
                      const langLabel = hasAudio
                        ? (format.format_note || (format.language ? `audio: ${format.language}` : null))
                        : null;
                      return (
                        <SelectItem key={format.format_id} value={format.format_id}>
                          {format.resolution || "Audio only"} ({format.ext.toUpperCase()})
                          {format.quality ? ` - ${format.quality}` : ''}
                          {langLabel ? ` · ${langLabel}` : ''}
                        </SelectItem>
                      );
                    })
                  }
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {downloadComplete && downloadId ? (
              wasSavedToCustom && finalFilePath ? (
                <div className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <FolderCheck className="h-4 w-4" />
                  Saved to your folder
                </div>
              ) : (
                <Button size="sm" onClick={handleSaveToComputer}>
                  <DownloadIcon className="h-4 w-4" />
                  Save to your computer
                </Button>
              )
            ) : (
              <Button
                size="sm"
                onClick={handleDownload}
                disabled={isDownloading}
              >
                <DownloadIcon className="h-4 w-4" />
                {isDownloading
                  ? downloadProgress < 90
                    ? "Downloading…"
                    : "Processing…"
                  : "Download"}
              </Button>
            )}

            <div className="text-xs text-muted-foreground">
              File size:{" "}
              <span className="font-medium text-foreground">
                {selectedFormat ? formatFileSize(selectedFormat.filesize || selectedFormat.filesize_approx) : "Unknown"}
              </span>
            </div>
          </div>

          {downloadComplete && wasSavedToCustom && finalFilePath && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                <CheckCircle className="h-4 w-4 shrink-0" />
                <span className="font-mono text-xs">{finalFilePath}</span>
              </div>
              {showTranscribe && onTranscribe && (!transcribeJob || transcribeJob.status === "complete" || transcribeJob.status === "failed") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onTranscribe(finalFilePath, videoData.title, videoData.uploadDate, videoData.id, videoData.channelId, videoData.channelName)}
                >
                  <FileText className="h-4 w-4" />
                  {transcribeJob?.status === "complete" ? "Re-transcribe" : "Transcribe with Pipeline"}
                </Button>
              )}
              {transcribeJob && transcribeJob.status !== "complete" && transcribeJob.status !== "failed" && (
                <div className="rounded-md border bg-muted/40 px-3 py-2">
                  <div className="mb-1.5 flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      {transcribeJobLabel(transcribeJob.status)}
                    </span>
                    <span className="font-mono tabular-nums text-foreground">{transcribeJob.progress}%</span>
                  </div>
                  <Progress value={transcribeJob.progress} className="h-1.5" />
                </div>
              )}
              {transcribeJob?.status === "complete" && (
                <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  <CheckCircle className="h-4 w-4 shrink-0 text-emerald-500" />
                  <span>Transcribed — open in Library to read.</span>
                </div>
              )}
              {transcribeJob?.status === "failed" && (
                <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm">
                  <div className="font-medium text-destructive">Transcription failed</div>
                  {transcribeJob.error && (
                    <div className="mt-1 break-all font-mono text-xs">{transcribeJob.error}</div>
                  )}
                </div>
              )}
            </div>
          )}

          {downloadComplete && !wasSavedToCustom && downloadId && (
            <div className="mt-3 flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <CheckCircle className="h-4 w-4 shrink-0" />
              <span>Processing complete — click Save to your computer above.</span>
            </div>
          )}
        </div>
      </div>

      {showProgress && (
        <div className="border-t bg-muted/30 px-4 py-3">
          <div className="mb-1.5 flex items-center justify-between text-xs">
            <span className="font-medium text-muted-foreground">
              {downloadProgress < 90
                ? "Downloading video & audio"
                : downloadProgress < 100
                  ? "Processing & merging"
                  : "Complete"}
            </span>
            <span className="font-mono tabular-nums text-foreground">{downloadProgress}%</span>
          </div>
          <Progress value={downloadProgress} className="h-1.5" />

          {downloadProgress >= 90 && downloadProgress < 100 && (
            <p className="mt-2 text-xs text-muted-foreground">
              Merging audio and video tracks…
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
