import { useEffect, useState } from "react";
import { CircleAlert } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { formatBytes, speechPercent } from "./model.ts";
import { Bar } from "./parts.tsx";
import type { Preflight } from "./types.ts";
import "./setup.css";

/** Shown when someone asks to transcribe before the speech engine is installed. */
export function SpeechPrompt({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const { setup, device, refreshSetup, refresh, openActivity } = useApp();
  const toast = useToast();
  const [pre, setPre] = useState<Preflight>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.setupPreflight().then(setPre).catch(() => setPre(undefined));
  }, []);
  const install = setup?.speech.setup;
  const running = install?.status === "running";
  const lowDisk = !!pre && pre.freeBytes != null && pre.freeBytes < pre.neededBytes;
  const problem = !pre
    ? null
    : !pre.ffmpeg
      ? "ffmpeg is missing. Install it with your system's package manager, then try again."
      : lowDisk
        ? `Needs about ${formatBytes(pre.neededBytes)} free. ${formatBytes(pre.freeBytes ?? 0)} available.`
        : !pre.network.ok
          ? pre.network.error
          : null;
  const start = async () => {
    setBusy(true);
    try {
      await api.speechSetupStart();
      await api.transcribe(mediaId, device);
      refresh();
      await refreshSetup();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const pct = install ? speechPercent(install) : null;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={running ? "Installing the speech engine" : "The speech engine isn't installed yet"}
      footer={
        running ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                onClose();
                openActivity();
              }}
            >
              Status & Health
            </Button>
            <Button onClick={onClose}>Close</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Not now
            </Button>
            <Button variant="primary" disabled={busy || !pre || !!problem} onClick={() => void start()}>
              Install and transcribe
            </Button>
          </>
        )
      }
    >
      <div className="setup-prompt">
        {running ? (
          <>
            <Bar pct={pct} />
            <p>This recording is queued and starts by itself when the install finishes. Progress is in Status &amp; Health.</p>
          </>
        ) : (
          <>
            <p>
              Transcription runs on this computer and needs about {formatBytes(pre?.modelBytes ?? 950e6)} of models, plus the voice-matching runtime. It installs in
              the background.
            </p>
            {problem && (
              <p role="alert" className="setup-error">
                <CircleAlert size={14} aria-hidden /> {problem}
              </p>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
