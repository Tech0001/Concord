// Mock answers for adding: dropped paths, link previews, following, and the queue they feed.
import * as fx from "./fixtures.ts";
import type { Source } from "../pipeline/types.ts";

const params = new URLSearchParams(location.search);
const NOW = () => Math.floor(Date.now() / 1000);
const MEDIA = ["mp4", "mkv", "webm", "mov", "ogg", "wav", "mp3", "m4a", "flac", "aac", "opus"];
const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

export const sources: Source[] = params.has("empty-library")
  ? []
  : [
      { id: "src-tuesday", name: "Tuesday Study", kind: "youtube", url: "https://www.youtube.com/@TuesdayStudy", enabled: 1, diarize: 1, include_shorts: 0, category: "personal", last_check: NOW() - 2 * 3600, check_status: "complete", check_message: "1 new video", recordings: 12, since: NOW() - 9 * 86400 },
      { id: "src-interviews", name: "Interviews", kind: "folder", url: "/home/you/Recordings/Interviews", enabled: 1, diarize: 1, include_shorts: 0, category: "work", last_check: NOW() - 20 * 60, check_status: "complete", check_message: "", recordings: 8, since: NOW() - 30 * 86400 },
    ];

const downloader = params.has("no-downloader")
  ? { enabled: false, installed: false, version: null as string | null, install: { running: false, message: "", error: null as string | null, done: 0, total: 0 } }
  : { enabled: true, installed: true, version: "2026.09.20", install: { running: false, message: "", error: null as string | null, done: 0, total: 0 } };

let paused = params.has("paused");
let downloadFolder = "";
/** Recordings with work in progress, shown on their cards and on Activity. */
const busy = params.has("empty-library")
  ? []
  : [
      { media: fx.mediaList[0], status: "running", kind: "download", path: null, message: "45.2% · 3.1MiB/s · 0:42 left" },
      { media: fx.mediaList[1], status: "queued", kind: "download", path: null, message: "Waiting in the processing queue" },
      { media: fx.mediaList[2], status: "queued", kind: "transcribe", path: fx.mediaList[2].path, message: "Waiting in the processing queue" },
      { media: fx.mediaList[6], status: "queued", kind: "transcribe", path: fx.mediaList[6].path, message: "Waiting in the processing queue" },
      { media: fx.mediaList[13], status: "failed", kind: "transcribe", path: fx.mediaList[13].path, message: "This file can't be read. It may still be recording, or be damaged." },
    ];

/** Library rows carry their job, as the backend's library query does. */
export function withJobs<T extends { id: string }>(items: T[]): T[] {
  return items.map((m) => {
    const job = busy.find((b) => b.media.id === m.id);
    if (!job) return m;
    const status = job.status === "running" ? "processing" : job.status === "queued" ? "pending" : "failed";
    return { ...m, processing_status: status, job_kind: job.kind, job_message: job.message, ...(job.path ? {} : { path: null }) };
  });
}

const queueJobs = () =>
  busy.map((b, i) => ({ id: `queue-${i}`, media_id: b.media.id, title: b.media.title, channel: b.media.channel, path: b.path, status: b.status, message: b.message, kind: b.kind, device: "auto", attempts: b.status === "failed" ? 3 : 0, retry_at: 0, cancelled: 0, finished_at: null }));
export const overview = () => {
  const jobs = queueJobs();
  const n = (s: string) => jobs.filter((j) => j.status === s).length;
  return { running: !paused, active: n("running"), activeKind: jobs.find((j) => j.status === "running")?.kind ?? null, queued: n("queued"), retry: n("retry"), waitingLive: 0, failed: n("failed"), dailyDownloads: 9, dailyLimit: 200, atDailyLimit: false };
};

function preview(input: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { input, kind: "unsupported", error: "Not a link" };
  }
  if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(url.hostname))
    return { input, kind: "unsupported", error: "This isn't a video, channel or playlist link Concord can add." };
  const id = url.hostname === "youtu.be" ? url.pathname.slice(1) : url.searchParams.get("v") ?? url.pathname.split("/")[2] ?? "";
  if (url.hostname === "youtu.be" || url.pathname === "/watch" || /^\/(shorts|live)\//.test(url.pathname)) {
    const titles = ["Community garden interview", "Starting a food co-op, questions and answers", "Week 6: holding grief and hope together"];
    const title = titles[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % titles.length];
    return {
      input,
      kind: "video",
      video: { url: `https://www.youtube.com/watch?v=${id}`, id, title, channel: "Tuesday Study", channelUrl: "https://www.youtube.com/@TuesdayStudy", duration: 3151, date: "20260914" },
      existing: id === "existing123",
      followingChannel: sources.some((s) => s.url === "https://www.youtube.com/@TuesdayStudy"),
    };
  }
  if (url.pathname === "/playlist") return { input, kind: "playlist", url: input, name: "Fall programs", handle: null, latest: "20261002", following: false };
  const handle = url.pathname.split("/")[1] ?? "";
  const name = handle.replace(/^@/, "").replace(/([a-z])([A-Z])/g, "$1 $2") || "A channel";
  return { input, kind: "channel", url: `https://www.youtube.com/${handle}`, name, handle: handle.startsWith("@") ? handle : null, latest: "20261004", following: sources.some((s) => s.url.toLowerCase() === `https://www.youtube.com/${handle}`.toLowerCase()) };
}

export const addingHandlers: Record<string, (a: any) => unknown> = {
  sources_list: () => sources,
  pipeline_overview: overview,
  pipeline_action: ({ action }) => {
    if (action === "pause") paused = true;
    if (action === "start") paused = false;
  },
  pipeline_check: ({ id }) => {
    const s = sources.find((x) => x.id === id);
    if (!s) return;
    s.check_status = "checking";
    setTimeout(() => Object.assign(s, { check_status: "complete", last_check: NOW(), check_message: "Nothing new" }), 3000);
  },
  pipeline_stop_check: () => {
    for (const s of sources) if (["checking", "queued"].includes(s.check_status)) Object.assign(s, { check_status: "cancelled", check_message: "Source check stopped" });
  },
  pipeline_save_source: ({ source }) => {
    const s = sources.find((x) => x.id === source.id);
    if (s) Object.assign(s, { name: source.name, category: source.category, diarize: source.diarize ? 1 : 0, include_shorts: source.includeShorts ? 1 : 0, enabled: source.enabled ? 1 : 0 });
    return source.id;
  },
  pipeline_remove_source: ({ id }) => {
    const i = sources.findIndex((s) => s.id === id);
    if (i >= 0) sources.splice(i, 1);
  },
  add_inspect_paths: ({ paths }: { paths: string[] }) => {
    const files = paths.filter((p) => MEDIA.includes(p.split(".").pop()?.toLowerCase() ?? "")).map((p) => ({ path: p, name: base(p), bytes: 48_000_000 + p.length * 1_300_000 }));
    const folders = paths.filter((p) => !/\.[a-z0-9]{2,4}$/i.test(p)).map((p) => ({ path: p, name: base(p) }));
    const skipped = paths.filter((p) => !files.some((f) => f.path === p) && !folders.some((f) => f.path === p));
    return { files, folders, skipped };
  },
  add_folder_preview: ({ path }) => ({ name: base(path), path, files: 23, existing: 3, bytes: 4_100_000_000 }),
  add_folder: ({ path, watch, category, diarize }) => {
    const id = `src-${base(path).toLowerCase()}`;
    if (watch) sources.push({ id, name: base(path), kind: "folder", url: path, enabled: 1, diarize: diarize ? 1 : 0, include_shorts: 0, category, last_check: NOW(), check_status: "complete", check_message: "", recordings: 20, since: NOW() });
    return { id, name: base(path), added: 20 };
  },
  add_preview_links: async ({ urls }: { urls: string[] }) => {
    await new Promise((r) => setTimeout(r, 700));
    return urls.map(preview);
  },
  add_videos: ({ videos }) => ({ added: videos.length, existing: 0, ids: [] }),
  add_follow: ({ url, name, category, diarize, includeShorts }) => {
    const id = `src-${name.toLowerCase().replace(/\W+/g, "-")}`;
    if (!sources.some((s) => s.id === id))
      sources.push({ id, name, kind: "youtube", url, enabled: 1, diarize: diarize ? 1 : 0, include_shorts: includeShorts ? 1 : 0, category, last_check: 0, check_status: "", check_message: "", recordings: 0, since: NOW() });
    return id;
  },
  import_and_queue: ({ paths }) => paths.length,
  download_folder: () => ({ folder: downloadFolder, suggested: "/home/you/Videos/Concord" }),
  set_download_folder: ({ folder }) => {
    downloadFolder = folder;
  },
  downloader_status: () => downloader,
  downloader_enable: ({ enabled }) => {
    downloader.enabled = enabled;
  },
  downloader_install: () => {
    downloader.enabled = true;
    downloader.install = { running: true, message: "Downloading yt-dlp from GitHub…", error: null, done: 0, total: 3_000_000 };
    const tick = setInterval(() => {
      downloader.install.done = Math.min(downloader.install.total, downloader.install.done + 600_000);
      if (downloader.install.done >= downloader.install.total) {
        clearInterval(tick);
        Object.assign(downloader, { installed: true, version: "2026.09.20" });
        downloader.install = { running: false, message: "yt-dlp 2026.09.20 is installed and verified.", error: null, done: 0, total: 0 };
      }
    }, 500);
  },
  pipeline_state_jobs: () => queueJobs(),
};
