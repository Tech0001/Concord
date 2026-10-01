import { useState } from "react";
import { Check, FolderOpen, HardDrive, History, LoaderCircle, Plus } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { SetupFoot, SetupHead, tildify } from "./parts.tsx";
import type { StepProps } from "./steps.ts";

const n = (value: number) => value.toLocaleString("en-US");

export function LibraryStep({ status, next }: StepProps) {
  const { importLegacy, refresh, refreshSetup } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState<"" | "new" | "legacy" | "pick">("");
  const [dismissed, setDismissed] = useState(false);
  const run = async (kind: typeof busy, work: () => Promise<boolean>) => {
    setBusy(kind);
    try {
      if (await work()) {
        refresh();
        await refreshSetup();
        next();
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy("");
    }
  };
  const startNew = () =>
    run("new", async () => {
      await api.startLibrary();
      return true;
    });
  const legacy = !status.library.started && !dismissed ? status.legacy : null;
  const storage = (
    <span className="setup-foot-note">
      <HardDrive size={16} aria-hidden />
      <span>
        Your library is stored on this computer in <code className="setup-path">{tildify(status.library.dataRoot)}</code>
      </span>
    </span>
  );

  if (status.library.started)
    return (
      <>
        <div className="setup-content">
          <SetupHead eyebrow="Step 1 of 5" accent title="Your library is ready">
            {status.library.imported ? "Your previous library was imported." : "You started a new library."} Continue to set up transcription and the rest.
          </SetupHead>
          <div className="setup-callout is-ok">
            <span className="setup-callout-icon">
              <Check size={20} aria-hidden />
            </span>
            <div className="setup-callout-body">
              <span className="setup-callout-title">{status.library.imported ? "Library imported" : "New library started"}</span>
              <span className="setup-path">{tildify(status.library.dataRoot)}</span>
            </div>
          </div>
        </div>
        <SetupFoot note={storage} primary={{ label: "Continue", onClick: next }} />
      </>
    );

  return (
    <>
      <div className="setup-content">
        <SetupHead eyebrow="Welcome to Concord" accent title="Let's set up your library">
          Concord keeps your recordings, transcripts, speakers and notes on this computer. Setup takes a few minutes, and only this first
          choice is required.
        </SetupHead>
        <div className="setup-grid">
          <button type="button" className="setup-option is-primary" disabled={!!busy} onClick={() => void startNew()}>
            <span className="setup-option-icon">{busy === "new" ? <LoaderCircle size={19} className="spin" aria-hidden /> : <Plus size={19} aria-hidden />}</span>
            <span className="setup-option-text">
              <span className="setup-option-title">Start a new library</span>
              <span className="setup-option-desc">An empty library. You'll add recordings in a moment.</span>
            </span>
          </button>
          <button type="button" className="setup-option" disabled={!!busy} onClick={() => void run("pick", () => importLegacy())}>
            <span className="setup-option-icon">{busy === "pick" ? <LoaderCircle size={19} className="spin" aria-hidden /> : <FolderOpen size={19} aria-hidden />}</span>
            <span className="setup-option-text">
              <span className="setup-option-title">Import a library…</span>
              <span className="setup-option-desc">From another computer or a backup. Recordings, speaker profiles and notes come across.</span>
            </span>
          </button>
        </div>
        {legacy && (
          <section className="setup-callout" aria-label="Previous library found">
            <span className="setup-callout-icon">
              <History size={20} aria-hidden />
            </span>
            <div className="setup-callout-body">
              <span className="setup-callout-title">We found your library from the previous Concord app</span>
              <span className="setup-path">{tildify(legacy.folder)}</span>
              <div className="setup-chips">
                <Chip>{n(legacy.recordings)} recordings</Chip>
                <Chip>{n(legacy.speakers)} speakers</Chip>
                <Chip>{n(legacy.notes)} notes</Chip>
                {legacy.speechModelsReusable && (
                  <Chip tone="success">{legacy.reusableBytes >= 950e6 ? "Speech models can be reused" : "Some speech models can be reused"}</Chip>
                )}
              </div>
              <div className="setup-actions">
                <Button
                  variant="secondary"
                  className="setup-cta"
                  icon={busy === "legacy" ? LoaderCircle : undefined}
                  disabled={!!busy}
                  onClick={() => void run("legacy", () => importLegacy(legacy.path))}
                >
                  {busy === "legacy" ? "Importing…" : "Import this library"}
                </Button>
                <Button variant="ghost" className="setup-cta" disabled={!!busy} onClick={() => setDismissed(true)}>
                  Dismiss
                </Button>
              </div>
            </div>
          </section>
        )}

      </div>
      <SetupFoot note={storage} />
    </>
  );
}
