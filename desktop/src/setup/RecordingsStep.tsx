import { useState } from "react";
import { AudioLines, FileText, Folder, FolderOpen, Link, LoaderCircle, Rss, Upload, X } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { isFollowed } from "../library/following.ts";
import { speechState } from "./model.ts";
import { SetupFoot, SetupHead, tildify } from "./parts.tsx";
import type { StepProps } from "./steps.ts";

const basename = (path: string) => path.replace(/\/+$/, "").split(/[\\/]/).pop() || path;

/** The same ways in as everywhere else: files, a folder or links open Add; documents get their own folder. */
export function RecordingsStep({ status, next, skip, back, detour }: StepProps) {
  const { refresh, refreshSetup, navigate, chooseToAdd, openAdd, overview, sources } = useApp();
  const toast = useToast();
  const [docs, setDocs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const following = sources.filter(isFollowed);
  const addDocuments = async () => {
    setBusy(true);
    try {
      const path = await api.pickFolder("Choose a documents folder");
      if (!path) return;
      await api.addDocumentRoot(path, basename(path));
      setDocs((list) => [...list, path]);
      refresh();
      await refreshSetup();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const stopFollowing = async (id: string) => {
    try {
      await api.pipelineRemoveSource(id);
      refresh();
      await refreshSetup();
    } catch (e) {
      toast.error(e);
    }
  };
  const recordings = overview?.media ?? 0;
  const anything = recordings > 0 || following.length > 0 || docs.length > 0 || status.sources.documentFolders > 0;
  const speechReady = speechState(status) === "installed";
  const tile = (Icon: typeof Upload, title: string, text: string, onClick: () => void) => (
    <button type="button" className="setup-option" disabled={busy} onClick={onClick}>
      <span className="setup-option-icon">
        <Icon size={19} aria-hidden className={Icon === LoaderCircle ? "spin" : undefined} />
      </span>
      <span className="setup-option-text">
        <span className="setup-option-title">{title}</span>
        <span className="setup-option-desc">{text}</span>
      </span>
    </button>
  );
  return (
    <>
      <div className="setup-content">
        <SetupHead eyebrow={detour ? "Recordings" : "Step 3 of 5 · Optional"} title="Bring in your recordings">
          Add some now or later. You can drop files or a folder anywhere in this window at any time.{" "}
          {speechReady
            ? "Anything you add is transcribed by itself."
            : status.speech.setup.status === "running"
              ? "Anything you add is transcribed as soon as the speech engine finishes installing."
              : "Recordings you add wait until the speech engine is installed."}
        </SetupHead>
        <div className="setup-grid setup-tiles">
          {tile(Upload, "Choose files", "Audio or video from this computer.", () => void chooseToAdd("files"))}
          {tile(FolderOpen, "Choose a folder", "Adds the recordings inside it, and can keep watching it for new ones.", () => void chooseToAdd("folder"))}
          {tile(Link, "Paste a link", "A video link adds that video. A channel link can be followed for new videos.", () => openAdd())}
          {tile(busy ? LoaderCircle : FileText, "Documents folder", "Markdown and text files, searchable on the Docs page.", () => void addDocuments())}
        </div>
        <section className="setup-section" aria-label="In your library">
          <span className="setup-label">
            In your library <small className="muted">· Personal and Work stay separate. Switch between them from the top bar.</small>
          </span>
          {anything ? (
            <div className="setup-added">
              {recordings > 0 && (
                <div className="setup-added-row">
                  <AudioLines size={18} aria-hidden />
                  <span className="setup-added-text">
                    <b>{count(recordings, "recording")}</b>
                    <small className="muted">{speechReady ? "Transcribed one after another as they arrive" : "Waiting for the speech engine"}</small>
                  </span>
                </div>
              )}
              {following.map((s) => {
                const Icon = s.kind === "folder" ? Folder : Rss;
                return (
                  <div className="setup-added-row" key={s.id}>
                    <Icon size={18} aria-hidden />
                    <span className="setup-added-text">
                      <b>{s.name}</b>
                      {s.kind === "folder" ? <span className="setup-path">{tildify(s.url)}</span> : <small className="muted">New videos are added as they're posted</small>}
                    </span>
                    <span className="setup-added-meta">{s.kind === "folder" ? "Watching" : "Following"}</span>
                    <Chip>{s.category === "work" ? "Work" : "Personal"}</Chip>
                    <IconButton label={`Stop following ${s.name}`} icon={X} size="sm" onClick={() => void stopFollowing(s.id)} />
                  </div>
                );
              })}
              {docs.map((path) => (
                <div className="setup-added-row" key={path}>
                  <FileText size={18} aria-hidden />
                  <span className="setup-added-text">
                    <b>{basename(path)}</b>
                    <span className="setup-path">{tildify(path)}</span>
                  </span>
                  <span className="setup-added-meta">Searchable in Docs</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="setup-empty-added">Nothing added yet</div>
          )}
          {(status.sources.documentFolders > 0 || docs.length > 0) && (
            <div className="setup-source-actions">
              <Button size="sm" onClick={() => navigate({ page: "documents" })}>
                Open Docs
              </Button>
            </div>
          )}
        </section>
      </div>
      <SetupFoot back={back} skip={anything ? null : skip} primary={{ label: detour ? "Done" : "Continue", onClick: () => (anything || !skip ? next() : skip()) }} />
    </>
  );
}
