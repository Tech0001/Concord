import { useState } from "react";
import { ChevronDown, ChevronLeft, Folder, RefreshCw, Rss } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count, initials } from "../lib/format.ts";
import type { Source, SourceInput } from "../pipeline/types.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { Menu, type MenuEntry } from "../ui/Menu.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { followingMeta, followingNote, isFollowed, sourceKind } from "./following.ts";

/** The top of a followed channel or watched folder: when it was checked, and its options. */
export function FollowingHeader({ source }: { source: Source }) {
  const { navigate, refresh } = useApp();
  const toast = useToast();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const followed = isFollowed(source);
  const folder = source.kind === "folder";
  const checking = source.check_status === "checking";
  const save = async (patch: Partial<SourceInput>) => {
    const input: SourceInput = {
      id: source.id,
      name: source.name,
      url: source.url,
      kind: source.kind,
      enabled: source.enabled === 1,
      diarize: source.diarize === 1,
      includeShorts: source.include_shorts === 1,
      category: source.category,
      ...patch,
    };
    try {
      await api.pipelineSaveSource(input);
      refresh();
      return true;
    } catch (e) {
      toast.error(e);
      return false;
    }
  };
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await work();
      refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  // The check starts in the background; look again shortly so "Checking…" shows and is then followed.
  const check = () => run(() => api.pipelineCheck(source.id)).then(() => void setTimeout(refresh, 1000));
  const follow = () => run(() => api.addFollow(source.url, source.name, source.category, source.diarize === 1, source.include_shorts === 1));
  const stop = () =>
    run(async () => {
      await api.pipelineRemoveSource(source.id);
      navigate({ page: "library" });
      toast.success(`${folder ? "Stopped watching" : "Stopped following"} ${source.name}`);
    });
  const entries: MenuEntry[] = [
    { kind: "label", label: "Add to" },
    { label: "Personal", checked: source.category === "personal", onSelect: () => void save({ category: "personal" }) },
    { label: "Work", checked: source.category === "work", onSelect: () => void save({ category: "work" }) },
    { kind: "separator" },
    { label: "Identify speakers", checked: source.diarize === 1, onSelect: () => void save({ diarize: source.diarize !== 1 }) },
    ...(sourceKind(source) === "Channel"
      ? [{ label: "Include Shorts", checked: source.include_shorts === 1, onSelect: () => void save({ includeShorts: source.include_shorts !== 1 }) }]
      : []),
    { label: "Rename…", onSelect: () => setRenaming(source.name) },
    { kind: "separator" },
    {
      label: folder ? "Stop watching" : followed ? "Stop following" : "Remove",
      danger: true,
      hint: "Recordings already added stay in your library.",
      onSelect: () => setStopping(true),
    },
  ];
  const name = renaming?.trim() ?? "";
  return (
    <>
      <button type="button" className="collection-back" onClick={() => navigate({ page: "library" })}>
        <ChevronLeft size={15} aria-hidden />
        Library
      </button>
      <section className="collection-head" aria-label={source.name}>
        <span className="collection-avatar" aria-hidden>
          {folder ? <Folder size={20} /> : initials(source.name)}
        </span>
        <div className="collection-text">
          <div className="collection-title">
            <h1>{source.name}</h1>
            {followed && (
              <Chip tone="accent">
                <Rss size={11} aria-hidden />
                {folder ? "Watching" : "Following"}
              </Chip>
            )}
          </div>
          <span className="collection-meta">{followingMeta(source)}</span>
          <p className="collection-note">
            {followed ? followingNote(source) : folder ? "Concord isn't watching this folder for new recordings." : "Concord isn't following this for new videos."}
          </p>
        </div>
        <div className="collection-actions">
          {followed || folder ? (
            <Button icon={RefreshCw} className={checking ? "is-checking" : undefined} disabled={busy || checking} onClick={() => void check()}>
              {checking ? "Checking…" : "Check now"}
            </Button>
          ) : (
            <Button variant="primary" icon={Rss} disabled={busy} onClick={() => void follow()}>
              Follow for new videos
            </Button>
          )}
          <Menu
            label="Following options"
            entries={entries}
            trigger={
              <Button>
                Options <ChevronDown size={14} aria-hidden />
              </Button>
            }
          />
        </div>
      </section>
      {renaming != null && (
        <Dialog
          open
          size="sm"
          onOpenChange={(open) => !open && setRenaming(null)}
          title={`Rename ${source.name}`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!name || name === source.name}
                onClick={() => void save({ name }).then((ok) => ok && setRenaming(null))}
              >
                Rename
              </Button>
            </>
          }
        >
          <label className="field">
            Name
            <input autoFocus value={renaming} maxLength={160} onChange={(e) => setRenaming(e.target.value)} />
          </label>
        </Dialog>
      )}
      <ConfirmDialog
        open={stopping}
        onOpenChange={setStopping}
        title={`${folder ? "Stop watching" : "Stop following"} ${source.name}?`}
        body={`Nothing new will be added from it. ${source.recordings ? `The ${count(source.recordings, "recording")} already added stay in your library.` : ""}`}
        confirmLabel={folder ? "Stop watching" : "Stop following"}
        danger
        onConfirm={() => void stop()}
      />
    </>
  );
}
