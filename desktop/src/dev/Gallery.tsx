// Dev-only design gallery (open with ?mock&gallery). Shows every primitive for screenshot review.
import { useEffect, useState } from "react";
import {
  Copy,
  Download,
  FolderOpen,
  LayoutGrid,
  List,
  MoreHorizontal,
  NotebookPen,
  Play,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { Button, IconButton } from "../ui/Button.tsx";
import { Menu } from "../ui/Menu.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { ToastProvider, useToast } from "../ui/Toasts.tsx";
import { Select } from "../ui/Select.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Chip, SpeakerChip } from "../ui/Chip.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Empty } from "../ui/Empty.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { SPEAKER_COLORS } from "./fixtures-colors.ts";
import "./gallery.css";

type DialogKind = "center" | "side" | "sheet" | null;

function Showcase() {
  const toast = useToast();
  const initial = new URLSearchParams(location.search).get("dialog") as DialogKind;
  const [dialog, setDialog] = useState<DialogKind>(initial);
  const [confirm, setConfirm] = useState(false);
  const [sort, setSort] = useState<"newest" | "oldest" | "title">("newest");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [mode, setMode] = useState<"system" | "dark" | "light">("dark");
  useEffect(() => {
    toast.success("Exported Harbour conversation — 12m03s–14m10s.m4a", { label: "Show in folder", run: () => {} });
    toast.info("Transcription started");
    toast.error(new Error("Media unavailable. Reconnect its drive or import a copy."));
  }, [toast]);
  return (
    <main className="gallery">
      <PageHeader
        title="Design gallery"
        meta="Every primitive, in every state"
        actions={
          <>
            <Button icon={Plus} variant="primary">
              Add recordings
            </Button>
            <Button icon={FolderOpen}>Import</Button>
          </>
        }
      />
      <section>
        <h3>Buttons</h3>
        <div className="gallery-row">
          <Button variant="primary" icon={Sparkles}>
            Transcribe
          </Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={Trash2}>
            Remove
          </Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button size="sm" icon={Play}>
            Small
          </Button>
          <IconButton label="Star" icon={Star} />
          <IconButton label="Starred" icon={Star} active />
          <IconButton label="Copy" icon={Copy} size="sm" />
        </div>
      </section>
      <section>
        <h3>Menus, selects, segmented</h3>
        <div className="gallery-row">
          <Menu
            label="Recording actions"
            trigger={<IconButton label="More actions" icon={MoreHorizontal} />}
            entries={[
              { label: "Open", icon: Play, onSelect: () => {} },
              { label: "Re-transcribe", icon: Sparkles, onSelect: () => {} },
              { kind: "separator" },
              { kind: "label", label: "Review" },
              { label: "Unreviewed", onSelect: () => {}, checked: true },
              { label: "Reviewed", onSelect: () => {} },
              { kind: "separator" },
              { label: "Export range…", icon: Download, onSelect: () => {}, hint: "E" },
              { label: "Show file in folder", icon: FolderOpen, onSelect: () => {}, disabled: true },
              { label: "Remove from library", icon: Trash2, onSelect: () => {}, danger: true },
            ]}
          />
          <Select
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: "newest", label: "Newest first" },
              { value: "oldest", label: "Oldest first" },
              { value: "title", label: "Title" },
            ]}
          />
          <Segmented
            label="View"
            value={view}
            onChange={setView}
            options={[
              { value: "grid", label: "Grid", icon: LayoutGrid, iconOnly: true },
              { value: "list", label: "List", icon: List, iconOnly: true },
            ]}
          />
          <Segmented
            label="Mode"
            value={mode}
            onChange={setMode}
            options={[
              { value: "system", label: "System" },
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
          />
          <label className="search-field">
            <Search size={15} />
            <input placeholder="Filter by title, collection, or file…" aria-label="Filter" />
          </label>
        </div>
      </section>
      <section>
        <h3>Chips</h3>
        <div className="gallery-row">
          <Chip>Not transcribed</Chip>
          <Chip tone="accent">12:03 – 14:10</Chip>
          <Chip tone="success">Reviewed</Chip>
          <Chip tone="warn">In review</Chip>
          <Chip tone="danger">Failed</Chip>
          {["Ada Marsh", "Tomás Ruiz", "Priya Natarajan", "Speaker 4"].map((name, i) => (
            <SpeakerChip key={name} name={name} color={SPEAKER_COLORS[i]} />
          ))}
          <SpeakerChip name="Grace Holloway" color={SPEAKER_COLORS[4]} size="sm" onClick={() => {}} />
          <Kbd>Ctrl K</Kbd>
          <Kbd>Space</Kbd>
        </div>
      </section>
      <section>
        <h3>Dialogs</h3>
        <div className="gallery-row">
          <Button onClick={() => setDialog("center")}>Center dialog</Button>
          <Button onClick={() => setDialog("side")}>Side panel</Button>
          <Button onClick={() => setDialog("sheet")}>Bottom sheet</Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            Confirm
          </Button>
        </div>
      </section>
      <section>
        <h3>Empty state</h3>
        <Empty icon={NotebookPen} title="A place to think" text="Save a passage from a transcript, or start a note here." action={<Button icon={Plus}>New note</Button>} />
      </section>
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => !open && setDialog(null)}
        title="Export range"
        description="12:03 – 14:10 · 2m 07s"
        variant={dialog ?? "center"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Download}>
              Export…
            </Button>
          </>
        }
      >
        <p className="dialog-text">Choose how to export this passage. Files are saved where you choose.</p>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this note?"
        body="The note and its links are removed. The recording is not affected."
        confirmLabel="Delete note"
        danger
        onConfirm={() => {}}
      />
    </main>
  );
}

export default function Gallery() {
  return (
    <ToastProvider>
      <Showcase />
    </ToastProvider>
  );
}
