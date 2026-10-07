import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { looksLikeLinks } from "./model.ts";
import type { AddSeed } from "./types.ts";

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Files dropped on the window, or links pasted outside a text field, open Add. True while something is dragged over. */
export function useDropAndPaste(openAdd: (seed: AddSeed) => void): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let alive = true;
    let stop = () => {};
    api
      .onDragDrop((event) => {
        setDragging(event.type === "enter" || event.type === "over");
        if (event.type === "drop" && event.paths.length) openAdd({ paths: event.paths });
      })
      .then((unlisten) => (alive ? (stop = unlisten) : unlisten()))
      .catch(() => {});
    const paste = (event: ClipboardEvent) => {
      if (editable(event.target)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!looksLikeLinks(text)) return;
      event.preventDefault();
      openAdd({ text });
    };
    window.addEventListener("paste", paste);
    return () => {
      alive = false;
      stop();
      window.removeEventListener("paste", paste);
    };
  }, [openAdd]);
  return dragging;
}

export function DropVeil() {
  return (
    <div className="drop-veil" aria-hidden>
      <div className="drop-veil-card">
        <Upload size={28} />
        <strong>Drop to add to your library</strong>
        <span>Audio or video files, or a folder of recordings</span>
      </div>
    </div>
  );
}
