import { useState } from "react";
import Header from "@/components/Header";
import UrlInput from "@/components/UrlInput";
import VideoPreview from "@/components/VideoPreview";
import Instructions from "@/components/Instructions";
import Footer from "@/components/Footer";
import LoadingIndicator from "@/components/LoadingIndicator";
import ErrorMessage from "@/components/ErrorMessage";
import DownloadSettings from "@/components/DownloadSettings";
import { VideoInfo, DownloadSettings as Settings } from "@/types/video";

export default function Home() {
  const [videoData, setVideoData] = useState<VideoInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadSettings, setDownloadSettings] = useState<Settings>({
    downloadLocation: ""
  });

  const handleVideoFetched = (video: VideoInfo) => {
    setVideoData(video);
    setError(null);
  };

  const handleError = (errorMessage: string) => {
    setError(errorMessage);
    setVideoData(null);
  };

  const updateDownloadProgress = (progress: number) => {
    setDownloadProgress(progress);
  };

  const handleSettingsChange = (settings: Settings) => {
    setDownloadSettings(settings);
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-6">
      <Header />

      <div className="space-y-4">
        <DownloadSettings onSettingsChange={handleSettingsChange} />

        <UrlInput
          onVideoFetched={handleVideoFetched}
          onLoading={setIsLoading}
          onError={handleError}
        />

        {isLoading && <LoadingIndicator />}

        {error && <ErrorMessage error={error} />}

        {videoData && (
          <VideoPreview
            videoData={videoData}
            downloadProgress={downloadProgress}
            isDownloading={isDownloading}
            setIsDownloading={setIsDownloading}
            updateDownloadProgress={updateDownloadProgress}
            downloadSettings={downloadSettings}
          />
        )}

        <Instructions />
        <Footer />
      </div>
    </div>
  );
}
