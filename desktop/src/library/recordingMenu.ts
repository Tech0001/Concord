import { Circle, CircleCheck, CircleDot, Copy, FolderOpen, History, Play, Sparkles, Star, StarOff } from "lucide-react";
import type { MenuEntry } from "../ui/Menu.tsx";
import type { Media, ReviewState } from "../lib/types.ts";
import { clock } from "../lib/format.ts";

export type RecordingActions = {
  open(at?: number): void;
  transcribe(): void;
  setStarred(starred: boolean): void;
  setCategory?(category: "personal" | "work"): void;
  setReview(state: ReviewState): void;
  reveal(): void;
  copyPath(): void;
  transcribeDisabled: boolean;
};

export const REVIEW_LABELS: Record<ReviewState, string> = { unreviewed: "Unreviewed", in_review: "In review", reviewed: "Reviewed" };
const REVIEW_ICONS = { unreviewed: Circle, in_review: CircleDot, reviewed: CircleCheck };

export function recordingMenu(m: Media, a: RecordingActions): MenuEntry[] {
  return [
    { label: "Open", icon: Play, onSelect: () => a.open() },
    ...(m.position > 5 ? [{ label: `Resume at ${clock(m.position)}`, icon: History, onSelect: () => a.open(m.position) }] : []),
    { label: !m.path && m.url ? "Download & transcribe" : m.transcript ? "Re-transcribe" : "Transcribe", icon: Sparkles, onSelect: a.transcribe, disabled: a.transcribeDisabled || m.status === "archived" || (!m.path && !m.url) },
    { kind: "separator" },
    { kind: "label", label: "Review" },
    ...(Object.keys(REVIEW_LABELS) as ReviewState[]).map((s) => ({
      label: REVIEW_LABELS[s],
      icon: REVIEW_ICONS[s],
      checked: m.review_state === s,
      onSelect: () => a.setReview(s),
    })),
    { kind: "separator" },
    m.starred
      ? { label: "Remove star", icon: StarOff, onSelect: () => a.setStarred(false) }
      : { label: "Star", icon: Star, onSelect: () => a.setStarred(true) },
    ...(a.setCategory ? [{ kind: "separator" as const }, { kind: "label" as const, label: "Category" }, ...(["personal", "work"] as const).map(c => ({ label: c === "work" ? "Work" : "Personal", checked: (m.category ?? "personal") === c, onSelect: () => a.setCategory?.(c) })), { kind: "separator" as const }] : []),
    { label: "Show file in folder", icon: FolderOpen, onSelect: a.reveal, disabled: !m.path },
    { label: "Copy file path", icon: Copy, onSelect: a.copyPath, disabled: !m.path },
  ];
}
