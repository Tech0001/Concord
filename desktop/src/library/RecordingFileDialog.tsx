import { useEffect, useState } from "react";
import { FilePenLine, FolderSearch, Pencil, Trash2 } from "lucide-react";
import { api } from "../lib/ipc.ts";
import type { Media } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import type { MenuEntry } from "../ui/Menu.tsx";
import { useToast } from "../ui/Toasts.tsx";
export type FileAction = "title" | "rename" | "relink" | "trash";
export type RecordingFileInfo = {
  id: string;
  title: string;
  path: string | null;
  exists: boolean;
  filename: string | null;
  extension: string | null;
  shared: { id: string; title: string }[];
};
export const fileMenu = (
  m: Media,
  open: (action: FileAction) => void,
): MenuEntry[] => [
  { kind: "separator" },
  { label: "Edit title", icon: Pencil, onSelect: () => open("title") },
  {
    label: "Rename file",
    icon: FilePenLine,
    onSelect: () => open("rename"),
    disabled: !m.path || m.status === "archived",
  },
  {
    label: "Locate media file",
    icon: FolderSearch,
    onSelect: () => open("relink"),
  },
  {
    label: "Move media to Trash",
    icon: Trash2,
    onSelect: () => open("trash"),
    disabled: !m.path || m.status === "archived",
    danger: true,
  },
];
const titles = {
  title: "Edit recording title",
  rename: "Rename recording file",
  relink: "Locate recording file",
  trash: "Move recording file to Trash?",
};
export function RecordingFileDialog({
  media,
  action,
  onClose,
  onSaved,
}: {
  media: Media;
  action: FileAction;
  onClose: () => void;
  onSaved: (action: FileAction) => void;
}) {
  const [info, setInfo] = useState<RecordingFileInfo>();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    api
      .recordingFileInfo(media.id)
      .then((i) => {
        if (alive) {
          setInfo(i);
          setValue(
            action === "title"
              ? i.title
              : action === "rename"
                ? (i.filename ?? "")
                : "",
          );
        }
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [media.id, action]);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (action === "title") await api.setRecordingTitle(media.id, value);
      else await api.recordingFileAction(media.id, action, value);
      onSaved(action);
      onClose();
      toast.success(
        action === "title"
          ? "Recording title updated"
          : action === "rename"
            ? "File renamed"
            : action === "trash"
              ? "Media moved to Trash; transcript and notes kept"
              : "Recording file linked",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const browse = async () => {
    try {
      const path = await api.pickRecordingFile();
      if (path) setValue(path);
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      title={titles[action]}
      description={media.title}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={action === "trash" ? "danger" : "primary"}
            disabled={
              busy ||
              !info ||
              ((action === "rename" || action === "trash") && !info.exists) ||
              (action !== "trash" && !value.trim())
            }
            onClick={() => void save()}
          >
            {busy
              ? "Saving…"
              : action === "trash"
                ? "Move to Trash"
                : action === "rename"
                  ? "Rename file"
                  : action === "relink"
                    ? "Link this file"
                    : "Save title"}
          </Button>
        </>
      }
    >
      {!info && !error && <p>Reading recording details…</p>}
      {info && (
        <div className="recording-file-form">
          {info.path && action !== "title" && (
            <p className="recording-file-path">{info.path}</p>
          )}
          {(action === "title" || action === "rename") && (
            <label className="field">
              {action === "title" ? "Recording title" : "Filename"}
              <input
                aria-label={
                  action === "title" ? "Recording title" : "Recording filename"
                }
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                maxLength={action === "title" ? 500 : 255}
              />
              {action === "rename" && (
                <small>
                  The .{info.extension} extension and recording title stay as
                  they are.
                </small>
              )}
            </label>
          )}
          {action === "relink" && (
            <>
              <p>
                Choose a copy of this same recording. Transcript timing, speaker
                labels and notes will be retained. Concord checks an existing
                file fingerprint when available and checks the duration.
              </p>
              <label className="field">
                Media file
                <input
                  aria-label="Replacement media path"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Choose the recording on its new drive or folder"
                />
              </label>
              <Button
                icon={FolderSearch}
                onClick={() => void browse()}
                disabled={busy}
              >
                Browse for recording
              </Button>
            </>
          )}
          {action === "trash" && (
            <p>
              This moves the media file to your desktop Trash. The recording
              stays in Concord with its transcript, speaker labels, notes and
              search results. Restore the file from Trash and use Locate media
              file to reconnect it.
            </p>
          )}
          {action !== "title" && (
            <p className="muted">
              {info.shared.length > 1
                ? `This file is shared by ${info.shared.length} recordings. ${action === "trash" ? "Their media will all become unavailable." : "Their saved file paths will all be updated."}`
                : "Your transcripts and research stay in Concord."}
            </p>
          )}
          {!info.exists && (action === "rename" || action === "trash") && (
            <p role="alert">
              The file is unavailable. Reconnect its drive or use Locate media
              file.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="is-error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
