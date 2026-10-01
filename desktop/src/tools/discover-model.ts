export type YouTubeQuery = { query: string; order: string; pageToken?: string };
export type YouTubeHit = {
  videoId: string;
  channelId: string;
  channelName: string;
  title: string;
  description: string;
  publishedAt: string;
  live: boolean;
  mediaId?: string | null;
};
export type YouTubePage = { hits: YouTubeHit[]; nextPageToken: string | null };
export function phrases(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim().toLocaleLowerCase())
    .filter(Boolean);
}
export function relevance(
  hit: YouTubeHit,
  include: string[],
  exclude: string[],
): "include" | "exclude" | "neutral" {
  const text = (hit.title + "\n" + hit.description).toLocaleLowerCase();
  if (exclude.some((p) => text.includes(p))) return "exclude";
  return include.some((p) => text.includes(p)) ? "include" : "neutral";
}
export function appendHits(
  before: YouTubeHit[],
  next: YouTubeHit[],
): YouTubeHit[] {
  const seen = new Set(before.map((h) => h.videoId));
  return [
    ...before,
    ...next.filter((h) => {
      if (seen.has(h.videoId)) return false;
      seen.add(h.videoId);
      return true;
    }),
  ];
}
