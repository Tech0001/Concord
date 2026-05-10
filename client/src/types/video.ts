export interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  duration: string;
  views: string;
  uploadDate?: string | null;
  channelId?: string | null;
  channelName?: string | null;
  channelUrl?: string | null;
  formats: VideoFormat[];
}

export interface VideoFormat {
  format_id: string;
  format: string;
  ext: string;
  resolution?: string;
  quality?: string;
  filesize?: number;
  filesize_approx?: number;
}

export interface DownloadProgress {
  percent: number;
  downloaded_bytes: number;
  total_bytes: number;
}

