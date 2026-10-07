/** Links in pasted text, in order, without repeats. */
export function splitLinks(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s,<>"']+/gi) ?? [];
  return [...new Set(found.map((l) => l.replace(/[.)\]]+$/, "")))];
}
export const looksLikeLinks = (text: string) => /https?:\/\/\S/i.test(text);

/** The Add button's label, saying what it will do. */
export function addLabel({ recordings, videos, follows, watching }: { recordings: number; videos: number; follows: string[]; watching: boolean }): string {
  const kinds = [recordings > 0, videos > 0, follows.length > 0].filter(Boolean).length;
  if (kinds > 1) return "Add all";
  if (recordings > 0) return watching ? `Add ${recordings} and keep watching` : `Add ${recordings} recording${recordings === 1 ? "" : "s"}`;
  if (videos > 0) return `Add ${videos} video${videos === 1 ? "" : "s"}`;
  if (follows.length === 1) return `Follow ${follows[0]}`;
  if (follows.length > 1) return `Follow ${follows.length} channels`;
  return watching ? "Keep watching" : "Add";
}

type Previewed = { video: { channel: string; channelUrl: string | null }; followingChannel: boolean };
/** The channel to offer following after adding videos, when they all come from one channel not yet followed. */
export function followOffer(added: Previewed[]): { name: string; url: string } | null {
  const urls = new Set(added.map((a) => a.video.channelUrl));
  const first = added[0];
  if (urls.size !== 1 || !first?.video.channelUrl || added.some((a) => a.followingChannel)) return null;
  return { name: first.video.channel || "this channel", url: first.video.channelUrl };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** The confirmation after adding, naming what was added, followed and watched. */
export function addedMessage({ recordings, videos, follows, watching }: { recordings: number; videos: number; follows: string[]; watching: string[] }): string {
  const added = [recordings && plural(recordings, "recording"), videos && plural(videos, "video")].filter(Boolean).join(" and ");
  const following = follows.length === 1 ? `following ${follows[0]}` : follows.length > 1 ? `following ${follows.length} channels` : "";
  const watched = watching.length === 1 ? `watching ${watching[0]}` : watching.length > 1 ? `watching ${watching.length} folders` : "";
  const parts = [added && `${added} added`, following, watched].filter(Boolean);
  if (!parts.length) return "Already in your library";
  const text = parts.join(" · ");
  return text[0].toUpperCase() + text.slice(1);
}

const VIDEO_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"];
/** Whether any of these links needs the download tool (the hosts the backend accepts). */
export function needsDownloader(links: string[]): boolean {
  return links.some((link) => {
    try {
      return VIDEO_HOSTS.includes(new URL(link).hostname.toLowerCase());
    } catch {
      return false;
    }
  });
}

/** "20260914" as "September 14, 2026"; anything else as nothing. */
export function videoDate(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!m) return "";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** A link without its scheme, www. or query, for messages about it. */
export function shortLink(link: string): string {
  try {
    const url = new URL(link);
    return (url.hostname.replace(/^www\./, "") + url.pathname).replace(/\/$/, "");
  } catch {
    return link;
  }
}
