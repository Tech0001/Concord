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
  /** Language metadata from yt-dlp. `language` is ISO 639-1
   *  ("en", "es", "ja"); `format_note` is yt-dlp's free-form label
   *  (often spells out "English original", "Spanish (Latin
   *  America)", etc.). YouTube populates these on multi-track
   *  videos — without them the user has no way to tell which
   *  language an audio track is. */
  language?: string | null;
  acodec?: string;
  vcodec?: string;
  format_note?: string;
}

export interface DownloadProgress {
  percent: number;
  downloaded_bytes: number;
  total_bytes: number;
}

