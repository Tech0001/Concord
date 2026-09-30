import { LoaderCircle, Square } from "lucide-react";
import { api } from "../lib/ipc.ts";
import type { Job } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Empty } from "../ui/Empty.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { Activity } from "lucide-react";

const TONE: Record<string, "accent" | "success" | "danger" | "neutral"> = {
  running: "accent",
  complete: "success",
  failed: "danger",
  interrupted: "danger",
  cancelled: "neutral",
};
const LABEL: Record<string, string> = {
  running: "Running",
  complete: "Done",
  failed: "Failed",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
};

export function ActivityPanel({ open, onOpenChange, jobs }: { open: boolean; onOpenChange: (open: boolean) => void; jobs: Job[] }) {
  const toast = useToast();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Activity" variant="side">
      {jobs.length === 0 ? (
        <Empty icon={Activity} title="Nothing running" text="Transcription jobs appear here." />
      ) : (
        <ul className="job-list">
          {jobs.map((j) => (
            <li key={j.id} className="job">
              <div className="job-head">
                <b className="job-title">{j.title}</b>
                <Chip tone={TONE[j.status] ?? "neutral"}>
                  {j.status === "running" && <LoaderCircle size={12} className="spin" aria-hidden />}
                  {LABEL[j.status] ?? j.status}
                </Chip>
              </div>
              {j.message && <p className="job-message">{j.message}</p>}
              {j.status === "running" && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Square}
                  onClick={() => api.cancelTranscription().catch((e) => toast.error(e))}
                >
                  Cancel processing
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
