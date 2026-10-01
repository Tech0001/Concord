import { useId, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { useApp } from "../shell/AppContext.tsx";
import { api } from "../lib/ipc.ts";
import { clock } from "../lib/format.ts";
import { useToast } from "../ui/Toasts.tsx";
import type { ResearchHit } from "./types.ts";
export function Citation({
  number,
  hit,
  onNavigate,
}: {
  number: number;
  hit: ResearchHit;
  onNavigate?: () => void;
}) {
  const { navigate, openNote } = useApp();
  const toast = useToast();
  const [preview, setPreview] = useState(false);
  const id = useId();
  const open = async () => {
    onNavigate?.();
    if (hit.kind === "recording")
      navigate({ page: "recording", id: hit.id, at: hit.start ?? 0 });
    else if (hit.kind === "document")
      navigate({ page: "documents", id: hit.id });
    else
      try {
        const note = (await api.research()).notes.find((n) => n.id === hit.id);
        if (note) openNote(note);
        else toast.error("This note has been deleted");
      } catch (e) {
        toast.error(e);
      }
  };
  return (
    <Popover.Root open={preview} onOpenChange={setPreview}>
      <Popover.Anchor asChild>
        <button
          type="button"
          className="citation-chip"
          aria-label={`Source ${number}: ${hit.title}${hit.start != null ? ` at ${clock(hit.start)}` : ""}`}
          aria-describedby={preview ? id : undefined}
          onMouseEnter={() => setPreview(true)}
          onMouseLeave={() => setPreview(false)}
          onFocus={() => setPreview(true)}
          onBlur={() => setPreview(false)}
          onClick={() => void open()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setPreview(false);
            }
          }}
        >
          {number}
        </button>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          id={id}
          role="tooltip"
          className="citation-tooltip"
          side="top"
          sideOffset={6}
          collisionPadding={12}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <strong>{hit.title}</strong>
          {hit.start != null && <small>{clock(hit.start)}</small>}
          <span>{hit.text.slice(0, 600)}</span>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
