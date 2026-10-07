import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Check, CircleAlert, Download, Folder, FolderOpen, LoaderCircle, Mic, Rss, Upload, Video, X } from "lucide-react";
import { api, type DownloaderStatus } from "../lib/ipc.ts";
import { clock, count, extension, initials } from "../lib/format.ts";
import { formatBytes } from "../setup/model.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Switch } from "../ui/Switch.tsx";
import { errorMessage, useToast } from "../ui/Toasts.tsx";
import { addLabel, addedMessage, followOffer, needsDownloader, shortLink, splitLinks, videoDate } from "./model.ts";
import type { AddSeed, DroppedFile, FolderPreview, LinkPreview } from "./types.ts";
import "./add.css";

type FolderItem = { path: string; name: string; preview?: FolderPreview; error?: string; watch: boolean };
type Follow = { on: boolean; shorts: boolean };
type Channel = Extract<LinkPreview, { kind: "channel" | "playlist" }>;
type VideoItem = Extract<LinkPreview, { kind: "video" }>;
const VIDEO_FILES = ["mp4", "mkv", "webm", "mov"];
const MAX_LINKS = 50;

/** The one way in: files, folders and links, with what will happen spelled out on the button. */
export function AddDialog({ seeds, onClose }: { seeds: AddSeed[]; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [files, setFiles] = useState<DroppedFile[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [previews, setPreviews] = useState<Record<string, LinkPreview>>({});
  const [looking, setLooking] = useState(0);
  const [follow, setFollow] = useState<Record<string, Follow>>({});
  const [category, setCategory] = useState<"personal" | "work">(app.category || "personal");
  const [diarize, setDiarize] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<DownloaderStatus>();
  const [toolSkipped, setToolSkipped] = useState(false);
  const [installing, setInstalling] = useState(false);

  const addPaths = useCallback(
    async (paths: string[]) => {
      try {
        const found = await api.addInspectPaths(paths);
        setFiles((old) => [...old, ...found.files.filter((f) => !old.some((o) => o.path === f.path))]);
        setSkipped((old) => [...new Set([...old, ...found.skipped.map((p) => p.split(/[\\/]/).pop() || p)])]);
        setFolders((old) => [...old, ...found.folders.filter((f) => !old.some((o) => o.path === f.path)).map((f) => ({ ...f, watch: false }))]);
        for (const folder of found.folders)
          api.addFolderPreview(folder.path).then(
            (preview) => setFolders((old) => old.map((f) => (f.path === folder.path ? { ...f, preview, error: undefined } : f))),
            (e) => setFolders((old) => old.map((f) => (f.path === folder.path ? { ...f, error: errorMessage(e) } : f))),
          );
      } catch (e) {
        toast.error(e);
      }
    },
    [toast],
  );

  // Each drop, pick or paste while the dialog is open arrives as another seed.
  const handled = useRef(0);
  useEffect(() => {
    const fresh = seeds.slice(handled.current);
    handled.current = seeds.length;
    for (const seed of fresh) {
      if (seed.paths?.length) void addPaths(seed.paths);
      const pasted = seed.text?.trim();
      if (pasted) setText((old) => (old.trim() ? `${old.trimEnd()}\n${pasted}` : pasted));
    }
  }, [seeds, addPaths]);

  const links = useMemo(() => splitLinks(text).slice(0, MAX_LINKS), [text]);
  const wantsTool = needsDownloader(links);
  const toolReady = !!tool?.enabled && !!tool.installed;
  const usable = useCallback((link: string) => toolReady || !needsDownloader([link]), [toolReady]);

  // Read the download tool's state once a link needs it, and follow an install while it runs.
  useEffect(() => {
    if (!wantsTool) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const status = await api.downloaderStatus();
        if (!alive) return;
        setTool(status);
        if (status.install.running) timer = window.setTimeout(poll, 1000);
      } catch (e) {
        if (alive) toast.error(e);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wantsTool, installing, toast]);
  const install = async () => {
    setInstalling(true);
    try {
      if (tool?.installed) await api.downloaderEnable(true);
      else await api.downloaderInstall();
      setTool(await api.downloaderStatus());
    } catch (e) {
      toast.error(e);
    } finally {
      setInstalling(false);
    }
  };

  // Look links up shortly after typing stops; each link once.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    const ask = links.filter((l) => !asked.current.has(l) && usable(l));
    if (!ask.length) return;
    const timer = window.setTimeout(async () => {
      ask.forEach((l) => asked.current.add(l));
      setLooking((n) => n + 1);
      try {
        const items = await api.addPreviewLinks(ask);
        setPreviews((old) => ({ ...old, ...Object.fromEntries(items.map((i) => [i.input, i])) }));
        const follows = items.filter((i): i is Channel => (i.kind === "channel" || i.kind === "playlist") && !i.following);
        setFollow((old) => ({ ...Object.fromEntries(follows.map((i) => [i.input, { on: true, shorts: false }])), ...old }));
      } catch (e) {
        const failed = ask.map((l): LinkPreview => ({ input: l, kind: "error", error: errorMessage(e) }));
        setPreviews((old) => ({ ...old, ...Object.fromEntries(failed.map((i) => [i.input, i])) }));
      } finally {
        setLooking((n) => n - 1);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [links, usable]);

  const shown = links.map((link) => ({ link, preview: previews[link] }));
  const videos = shown.flatMap(({ preview: p }) => (p?.kind === "video" && !p.existing ? [p] : []));
  const channels = shown.flatMap(({ link, preview: p }) => ((p?.kind === "channel" || p?.kind === "playlist") && !p.following && follow[link]?.on ? [p] : []));
  const fromFolders = folders.reduce((n, f) => n + Math.max(0, (f.preview?.files ?? 0) - (f.preview?.existing ?? 0)), 0);
  const watching = folders.some((f) => f.watch && f.preview);
  const waiting = looking > 0 || links.some((l) => !previews[l] && usable(l)) || folders.some((f) => !f.preview && !f.error) || installing;
  const label = addLabel({ recordings: files.length + fromFolders, videos: videos.length, follows: channels.map((c) => c.name), watching });
  const empty = !files.length && !folders.length && !links.length && !skipped.length;
  const toolPanel = wantsTool && !toolReady && !toolSkipped && !!tool;

  const chooseFiles = async () => {
    try {
      const paths = await api.pickMedia();
      if (paths.length) await addPaths(paths);
    } catch (e) {
      toast.error(e);
    }
  };
  const chooseFolder = async () => {
    try {
      const path = await api.pickFolder("Choose a folder of recordings");
      if (path) await addPaths([path]);
    } catch (e) {
      toast.error(e);
    }
  };
  const record = () => {
    onClose();
    app.navigate({ page: "tools", tab: "record" });
  };

  // Each part is marked done as it lands, so a failure part-way leaves only the rest to retry.
  const submit = async () => {
    setBusy(true);
    const done = { recordings: 0, videos: 0, follows: [] as string[], watching: [] as string[] };
    let collection: string | undefined;
    const addedVideos: VideoItem[] = [];
    try {
      if (files.length) {
        done.recordings += await api.importAndQueue(files.map((f) => f.path), category, app.device, diarize);
        setFiles([]);
      }
      for (const folder of folders) {
        const fresh = (folder.preview?.files ?? 0) - (folder.preview?.existing ?? 0);
        if (!folder.preview || (fresh <= 0 && !folder.watch)) continue;
        const result = await api.addFolder(folder.path, folder.watch, category, diarize);
        done.recordings += result.added;
        if (folder.watch) {
          done.watching.push(result.name);
          collection = result.id;
        }
        setFolders((old) => old.filter((f) => f.path !== folder.path));
      }
      if (videos.length) {
        done.videos = (await api.addVideos(videos.map((v) => v.video), category, diarize, app.device)).added;
        addedVideos.push(...videos);
        setPreviews((old) => ({ ...old, ...Object.fromEntries(videos.map((v) => [v.input, { ...v, existing: true }])) }));
      }
      for (const channel of channels) {
        collection = await api.addFollow(channel.url, channel.name, category, diarize, follow[channel.input]?.shorts ?? false);
        done.follows.push(channel.name);
        setPreviews((old) => ({ ...old, [channel.input]: { ...channel, following: true } }));
      }
    } catch (e) {
      toast.error(e);
      setBusy(false);
      app.refresh();
      return;
    }
    setBusy(false);
    onClose();
    app.refresh();
    const onlyFollowing = !done.recordings && !done.videos && (done.follows.length + done.watching.length === 1);
    // Setup keeps its place; everywhere else, show where the new recordings are.
    if (app.route.page !== "setup") app.navigate(onlyFollowing && collection ? { page: "library", collection } : { page: "library" });
    const offer = followOffer(addedVideos);
    const speechMissing = app.setup && !app.setup.speech.installed && (done.recordings > 0 || done.videos > 0);
    toast.success(
      addedMessage(done),
      offer
        ? {
            label: `Follow ${offer.name}`,
            run: () =>
              void api
                .addFollow(offer.url, offer.name, category, diarize, false)
                .then(() => {
                  toast.success(`Following ${offer.name}`);
                  app.refresh();
                })
                .catch(toast.error),
          }
        : speechMissing
          ? { label: "Install speech engine", run: () => app.navigate({ page: "setup", step: "speech", returnTo: "library" }) }
          : undefined,
    );
  };

  const note = !app.setup || app.setup.speech.installed
    ? videos.length && !files.length && !fromFolders
      ? "Each video is downloaded, then transcribed. You'll see its progress in your Library."
      : channels.length && !files.length && !fromFolders && !videos.length
        ? "New videos are checked for while Concord is open."
        : "Recordings are transcribed one after another as soon as they're added. You can keep working."
    : "The speech engine isn't installed yet. What you add waits in your Library and is transcribed once it is.";

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !busy && onClose()}
      title="Add to your library"
      className="add-dialog"
      footer={
        <>
          <Segmented size="sm" label="Add to" value={category} onChange={setCategory} options={[{ value: "personal", label: "Personal" }, { value: "work", label: "Work" }]} />
          <Switch checked={diarize} onChange={setDiarize}>Identify speakers</Switch>
          <span className="spacer" />
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={busy || waiting ? LoaderCircle : undefined} className={busy || waiting ? "is-spinning" : undefined} disabled={busy || waiting || label === "Add"} onClick={() => void submit()}>
            {label}
          </Button>
          {!empty && <p className="add-note">{note}</p>}
        </>
      }
    >
      <div className="add-body">
        {empty ? (
          <div className="add-drop">
            <Upload size={22} aria-hidden className="add-drop-icon" />
            <strong>Drop recordings or a folder anywhere in this window</strong>
            <span>Audio and video files are transcribed as soon as they're added.</span>
            <div className="add-drop-actions">
              <Button icon={Upload} onClick={() => void chooseFiles()}>Choose files</Button>
              <Button icon={FolderOpen} onClick={() => void chooseFolder()}>Choose folder</Button>
              <Button icon={Mic} variant="ghost" onClick={record}>Record</Button>
            </div>
          </div>
        ) : (
          <>
            {files.length > 0 && (
              <ul className="add-list" aria-label="Recordings to add">
                {files.map((f) => {
                  const video = VIDEO_FILES.includes(extension(f.path));
                  const Icon = video ? Video : AudioLines;
                  return (
                    <li key={f.path} className="add-row">
                      <span className="add-row-icon"><Icon size={17} aria-hidden /></span>
                      <span className="add-row-text"><b>{f.name}</b><small>{video ? "Video" : "Audio"} · {formatBytes(f.bytes)}</small></span>
                      <IconButton size="sm" icon={X} label={`Remove ${f.name}`} onClick={() => setFiles((old) => old.filter((o) => o.path !== f.path))} />
                    </li>
                  );
                })}
              </ul>
            )}
            {folders.map((f) => (
              <FolderCard key={f.path} folder={f} onWatch={(watch) => setFolders((old) => old.map((o) => (o.path === f.path ? { ...o, watch } : o)))} onRemove={() => setFolders((old) => old.filter((o) => o.path !== f.path))} />
            ))}
            {skipped.length > 0 && (
              <p className="add-warning"><CircleAlert size={15} aria-hidden />{skipped.length === 1 ? `${skipped[0]} isn't an audio or video file. It will be skipped.` : `${count(skipped.length, "item")} aren't audio or video files and will be skipped: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`}</p>
            )}
            <div className="add-drop add-drop-compact">
              <Upload size={16} aria-hidden className="add-drop-icon" />
              <span>Drop more here, or</span>
              <Button size="sm" variant="ghost" onClick={() => void chooseFiles()}>Choose files</Button>
              <Button size="sm" variant="ghost" onClick={() => void chooseFolder()}>Choose folder</Button>
            </div>
          </>
        )}

        <label className="add-links">
          <span>{empty ? "Or paste links" : "Links"}</span>
          <textarea
            rows={links.length > 1 ? 3 : 2}
            value={text}
            placeholder="A video, channel or playlist link, or several, one per line"
            onChange={(e) => setText(e.target.value)}
          />
        </label>

        {toolPanel ? (
          <ToolPanel tool={tool} installing={installing} onInstall={() => void install()} onSkip={() => setToolSkipped(true)} />
        ) : (
          shown.length > 0 && (
            <ul className="add-list" aria-label="Links to add">
              {shown.map(({ link, preview }) =>
                !usable(link) ? (
                  <li key={link} className="add-warning">
                    <CircleAlert size={15} aria-hidden />
                    <span>{shortLink(link)} needs the download tool, so it will be skipped. <button type="button" className="add-link-button" onClick={() => setToolSkipped(false)}>Set it up</button></span>
                  </li>
                ) : (
                  <LinkRow key={link} link={link} preview={preview} follow={follow[link]} onFollow={(next) => setFollow((old) => ({ ...old, [link]: next }))} />
                ),
              )}
            </ul>
          )
        )}
        {splitLinks(text).length > MAX_LINKS && <p className="add-warning"><CircleAlert size={15} aria-hidden />Only the first {MAX_LINKS} links are added at once.</p>}
      </div>
    </Dialog>
  );
}

function FolderCard({ folder, onWatch, onRemove }: { folder: FolderItem; onWatch: (watch: boolean) => void; onRemove: () => void }) {
  const p = folder.preview;
  const fresh = p ? p.files - p.existing : 0;
  return (
    <section className="add-folder" aria-label={folder.name}>
      <div className="add-folder-head">
        <span className="add-row-icon"><Folder size={17} aria-hidden /></span>
        <span className="add-row-text">
          <b>{folder.name}</b>
          <small className="add-path">{folder.path}</small>
          {folder.error ? (
            <small className="add-error">{folder.error}</small>
          ) : !p ? (
            <small>Looking inside…</small>
          ) : (
            <>
              <small>{p.files ? `${count(p.files, "recording")} · ${formatBytes(p.bytes)}, including subfolders` : "No audio or video files here yet"}</small>
              {p.existing > 0 && <small>{p.existing === p.files ? "They're all in your library already." : `${count(p.existing, "is", "are")} already in your library and won't be added twice.`}</small>}
            </>
          )}
        </span>
        <IconButton size="sm" icon={X} label={`Remove ${folder.name}`} onClick={onRemove} />
      </div>
      {p && (
        <Switch
          checked={folder.watch}
          onChange={onWatch}
          className="add-folder-watch"
          hint="Recordings saved here later are added and transcribed while Concord is open. The folder shows under Following in your Library."
        >
          Keep watching this folder
        </Switch>
      )}
      {p && !fresh && !folder.watch && p.files > 0 && <small className="add-muted">Nothing new to add from this folder.</small>}
    </section>
  );
}

function LinkRow({ link, preview, follow, onFollow }: { link: string; preview?: LinkPreview; follow?: Follow; onFollow: (next: Follow) => void }) {
  if (!preview)
    return (
      <li className="add-row add-row-pending">
        <span className="add-row-icon"><LoaderCircle size={16} aria-hidden className="spin" /></span>
        <span className="add-row-text"><b>{shortLink(link)}</b><small>Looking it up…</small></span>
      </li>
    );
  if (preview.kind === "unsupported" || preview.kind === "error")
    return (
      <li className="add-warning">
        <CircleAlert size={15} aria-hidden />
        <span>{preview.kind === "unsupported" ? `${shortLink(link)} isn't a video, channel or playlist Concord can add. It will be skipped.` : `Couldn't read ${shortLink(link)}: ${preview.error}`}</span>
      </li>
    );
  if (preview.kind === "video") {
    const v = preview.video;
    return (
      <li className="add-row">
        <span className="add-duration">{v.duration ? clock(v.duration) : "–"}</span>
        <span className="add-row-text"><b>{v.title}</b><small>{[v.channel, videoDate(v.date)].filter(Boolean).join(" · ")}</small></span>
        <span className={preview.existing ? "add-status" : "add-status is-ready"}>{preview.existing ? "In your library" : "Ready to add"}</span>
      </li>
    );
  }
  const kind = preview.kind === "playlist" ? "Playlist" : "Channel";
  const latest = videoDate(preview.latest);
  return (
    <li className="add-channel">
      <div className="add-row">
        <span className="add-avatar" aria-hidden>{initials(preview.name)}</span>
        <span className="add-row-text">
          <b>{preview.name}</b>
          <small>{[kind, preview.handle, latest && `latest video ${latest}`].filter(Boolean).join(" · ")}</small>
        </span>
      </div>
      {preview.following ? (
        <p className="add-following"><Check size={15} aria-hidden />You follow {preview.name}. New videos are added as they're posted.</p>
      ) : (
        <div className="add-follow">
          <Switch
            checked={follow?.on ?? true}
            onChange={(on) => onFollow({ on, shorts: follow?.shorts ?? false })}
            hint="Videos posted from today on are downloaded and transcribed while Concord is open. Nothing older is downloaded; to add an older video, paste its link."
          >
            <Rss size={14} aria-hidden className="add-follow-icon" />Follow for new videos
          </Switch>
          {preview.kind === "channel" && (follow?.on ?? true) && (
            <Switch checked={follow?.shorts ?? false} onChange={(shorts) => onFollow({ on: true, shorts })}>Include Shorts</Switch>
          )}
        </div>
      )}
    </li>
  );
}

function ToolPanel({ tool, installing, onInstall, onSkip }: { tool: DownloaderStatus; installing: boolean; onInstall: () => void; onSkip: () => void }) {
  const run = tool.install;
  const off = tool.installed && !tool.enabled;
  return (
    <section className="add-tool" aria-label="Download tool">
      <span className="add-tool-icon"><Download size={18} aria-hidden /></span>
      <div className="add-tool-text">
        <strong>{off ? "Link downloads are turned off" : "Links need Concord's download tool"}</strong>
        <p>
          {off
            ? "Turn them back on to add videos and follow channels from links."
            : "To add videos from links, Concord installs yt-dlp, a free download tool, from its official project and checks it before use. It's set up once and only used for links you add."}
        </p>
        {run.running ? (
          <div role="status" className="add-tool-progress">
            <span>{run.message}</span>
            {run.total > 0 && <progress aria-label="Download tool" value={run.done} max={run.total} />}
          </div>
        ) : (
          <>
            {run.error && <p role="alert" className="add-error">{run.error}</p>}
            <div className="add-tool-actions">
              <Button variant="primary" disabled={installing} onClick={onInstall}>{off ? "Turn on and continue" : run.error ? "Try again" : "Install and continue"}</Button>
              <Button variant="ghost" onClick={onSkip}>Not now</Button>
            </div>
          </>
        )}
        <small>Only add videos you're allowed to download under the site's terms. You can turn link downloads off any time in Settings.</small>
      </div>
    </section>
  );
}
