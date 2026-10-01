import { useEffect, useState } from "react";
import { AudioLines, FileText, Folder, LoaderCircle, Rss, Upload, X } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { speechState } from "./model.ts";
import { SetupFoot, SetupHead, tildify } from "./parts.tsx";
import type { StepProps } from "./steps.ts";

type Kind = "files" | "folder" | "youtube" | "docs";
type Added = { key: string; kind: Kind; title: string; path: string; meta: string; category?: "personal" | "work"; sourceId?: string };
const ICON = { files: AudioLines, folder: Folder, youtube: Rss, docs: FileText };
const basename = (path: string) => path.replace(/\/+$/, "").split(/[\\/]/).pop() || path;

/** A readable source name from a channel or playlist address. */
export function youtubeName(url: string): string {
  const handle = /youtube\.com\/@([^/?#]+)/i.exec(url)?.[1];
  if (handle) return decodeURIComponent(handle);
  if (/[?&]list=/.test(url)) return "YouTube playlist";
  return "YouTube channel";
}

export function RecordingsStep({ status, next, skip, back, detour }: StepProps) {
  const { category, device, refresh, refreshSetup, navigate } = useApp();
  const toast = useToast();
  const [target, setTarget] = useState<"personal" | "work">(category === "work" ? "work" : "personal");
  const [added, setAdded] = useState<Added[]>([]);
  const [busy, setBusy] = useState<Kind | "">("");
  const [youtube, setYoutube] = useState(false);
  const [url, setUrl] = useState("");
  const [youtubeError, setYoutubeError] = useState("");
  const [tools, setTools] = useState<boolean>();
  useEffect(() => {
    api.pipelineTools().then((t) => setTools(t.ready)).catch(() => setTools(false));
  }, []);
  const add = (item: Omit<Added, "key">) => setAdded((list) => [...list, { ...item, key: `${item.kind}:${item.path}:${list.length}` }]);
  const run = async (kind: Kind, work: () => Promise<void>) => {
    setBusy(kind);
    try {
      await work();
      refresh();
      await refreshSetup();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy("");
    }
  };
  const addSource = async (kind: "folder" | "youtube", name: string, address: string) => {
    const id = await api.pipelineSaveSource({ name, kind, url: address, enabled: true, diarize: true, includeShorts: false, category: target });
    await api.pipelineCheck(id);
    add({ kind, title: name, path: address, meta: "Scan started · see Sources for results", category: target, sourceId: id });
  };
  const addFiles = () =>
    run("files", async () => {
      const paths = await api.pickMedia();
      if (!paths.length) return;
      const count = await api.importAndQueue(paths, target, device);
      const names = paths.map(basename);
      add({
        kind: "files",
        title: count === 1 ? "1 file" : `${count} files`,
        path: names.slice(0, 2).join(", ") + (names.length > 2 ? `, +${names.length - 2}` : ""),
        meta: count ? `${count} queued` : "Already in your library",
        category: target,
      });
    });
  const addFolder = () =>
    run("folder", async () => {
      const path = await api.pickFolder("Choose a folder of recordings");
      if (path) await addSource("folder", basename(path), path);
    });
  const addDocuments = () =>
    run("docs", async () => {
      const path = await api.pickFolder("Choose a documents folder");
      if (!path) return;
      await api.addDocumentRoot(path, basename(path));
      add({ kind: "docs", title: basename(path), path, meta: "Searchable in Docs" });
    });
  const addYoutube = async () => {
    setYoutubeError("");
    setBusy("youtube");
    try {
      await addSource("youtube", youtubeName(url.trim()), url.trim());
      setYoutube(false);
      setUrl("");
      refresh();
      await refreshSetup();
    } catch (e) {
      setYoutubeError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy("");
    }
  };
  const remove = (item: Added) =>
    run(item.kind, async () => {
      if (item.sourceId) await api.pipelineRemoveSource(item.sourceId);
      setAdded((list) => list.filter((x) => x.key !== item.key));
    });
  const existing = status.sources.sources + status.sources.documentFolders;
  const speechReady = speechState(status) === "installed";
  const tile = (kind: Kind, title: string, text: string, onClick: () => void, disabled = false) => {
    const Icon = kind === "files" ? Upload : ICON[kind];
    return (
      <button type="button" className="setup-option" disabled={!!busy || disabled} onClick={onClick}>
        <span className="setup-option-icon">{busy === kind ? <LoaderCircle size={19} className="spin" aria-hidden /> : <Icon size={19} aria-hidden />}</span>
        <span className="setup-option-text">
          <span className="setup-option-title">{title}</span>
          <span className="setup-option-desc">{text}</span>
        </span>
      </button>
    );
  };
  return (
    <>
      <div className="setup-content">
        <SetupHead eyebrow={detour ? "Recordings" : "Step 3 of 5 · Optional"} title="Bring in your recordings">
          Add some now or later.{" "}
          {speechReady
            ? "Anything you add is queued for transcription."
            : status.speech.setup.status === "running"
              ? "Anything you add is transcribed as soon as the speech engine finishes installing."
              : "Recordings you add wait until the speech engine is installed."}
        </SetupHead>
        <section className="setup-section">
          <span className="setup-label" id="add-to">
            Add to
          </span>
          <Segmented<"personal" | "work">
            label="Add to"
            value={target}
            onChange={setTarget}
            options={[
              { value: "personal", label: "Personal" },
              { value: "work", label: "Work" },
            ]}
          />
        </section>
        <div className="setup-grid setup-tiles">
          {tile("files", "Add files", "Audio or video from this computer. You can also drag them in any time.", () => void addFiles())}
          {tile("folder", "Add a folder", "Imports the audio and video inside it.", () => void addFolder())}
          {tile(
            "youtube",
            "YouTube channel or playlist",
            tools === false ? "Enable YouTube downloads in Settings first." : "Queues its videos to download and transcribe.",
            () => tools ? setYoutube(true) : navigate({ page: "settings", section: "youtube" }),
          )}
          {tile("docs", "Documents folder", "Markdown and text files, searchable on the Docs page.", () => void addDocuments())}
        </div>
        <section className="setup-section" aria-label="Added">
          <span className="setup-label">
            Added <small className="muted">· Personal and Work stay separate. Switch between them from the top bar.</small>
          </span>
          {added.length ? (
            <div className="setup-added">
              {added.map((item) => {
                const Icon = ICON[item.kind];
                return (
                  <div className="setup-added-row" key={item.key}>
                    <Icon size={18} aria-hidden />
                    <span className="setup-added-text">
                      <b>{item.title}</b>
                      <span className="setup-path">{tildify(item.path)}</span>
                    </span>
                    <span className="setup-added-meta">{item.meta}</span>
                    {item.category && <Chip>{item.category === "work" ? "Work" : "Personal"}</Chip>}
                    {item.sourceId && <IconButton label={`Remove ${item.title}`} icon={X} size="sm" onClick={() => void remove(item)} />}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="setup-empty-added">
              {existing ? "Your folders and sources are already set up. View scan results below." : "Nothing added yet"}
            </div>
          )}
          <div className="setup-source-actions">
            {(status.sources.sources > 0 || added.some(item => item.sourceId)) && <Button size="sm" onClick={() => navigate({ page: "pipeline", tab: "sources" })}>View sources & scan results</Button>}
            {(status.sources.documentFolders > 0 || added.some(item => item.kind === "docs")) && <Button size="sm" onClick={() => navigate({ page: "documents" })}>Open Docs</Button>}
          </div>
        </section>
      </div>
      <SetupFoot
        back={back}
        skip={added.length ? null : skip}
        primary={{ label: detour ? "Done" : "Continue", onClick: () => (added.length || existing || !skip ? next() : skip()) }}
      />
      <Dialog
        open={youtube}
        onOpenChange={(open) => {
          setYoutube(open);
          setYoutubeError("");
        }}
        title="Add a YouTube channel or playlist"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setYoutube(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!url.trim() || busy === "youtube"} icon={busy === "youtube" ? LoaderCircle : undefined} onClick={() => void addYoutube()}>
              Add
            </Button>
          </>
        }
      >
        <div className="setup-prompt">
          <label className="field">
            <span>Channel or playlist address</span>
            <input
              autoFocus
              value={url}
              placeholder="https://www.youtube.com/@channel"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && url.trim() && void addYoutube()}
            />
          </label>
          <p>New videos are downloaded and queued for transcription. Their category is {target === "work" ? "Work" : "Personal"}.</p>
          {youtubeError && (
            <p role="alert" className="setup-error">
              {youtubeError}
            </p>
          )}
        </div>
      </Dialog>
    </>
  );
}
