import { Check, Pause, Play } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { CHAT_NAME, SEARCH_NAME, formatBytes, recordingsSummary, speechPercent, speechState, speechSummary, stepState, type StepState } from "./model.ts";
import { Bar, SetupFoot, SetupHead, StateIcon } from "./parts.tsx";
import type { StepProps } from "./steps.ts";
import type { SetupStep } from "./types.ts";

type Row = { step: SetupStep; label: string; state: StepState; detail: string };

export function ReadyStep({ status, finish, go, look }: StepProps & { look: string }) {
  const { refreshSetup } = useApp();
  const toast = useToast();
  const speech = speechState(status);
  const install = status.speech.setup;
  const pct = speechPercent(install);
  const searchDownloading = ["waiting", "running"].includes(status.search.download.status);
  const state = (step: SetupStep) => stepState(status, step, "ready");
  const rows: Row[] = [
    { step: "library", label: "Library", state: state("library"), detail: status.library.imported ? "Previous library imported" : "New library started" },
    { step: "speech", label: "Speech engine", state: state("speech"), detail: speechSummary(status) },
    { step: "recordings", label: "Recordings", state: state("recordings"), detail: recordingsSummary(status) || "Nothing added yet" },
    {
      step: "ai",
      label: "Smart search",
      state: status.search.modelReady ? "done" : searchDownloading ? "running" : status.search.enabled ? "todo" : "skipped",
      detail: !status.search.enabled
        ? "Off · exact words only"
        : status.search.modelReady
          ? status.search.kind === "builtin"
            ? "On this computer · ready"
            : `${SEARCH_NAME[status.search.kind] ?? "Custom"} · ready`
          : searchDownloading
            ? `On this computer · downloads after the speech engine (${formatBytes(status.search.download.total)})`
            : "Not downloaded yet",
    },
    {
      step: "ai",
      label: "Ask your archive",
      state: status.chat.connected ? "done" : "skipped",
      detail: status.chat.connected ? `${CHAT_NAME[status.chat.kind] ?? "Custom"} · connected` : "Not set up · connect a provider any time",
    },
    { step: "look", label: "Look & feel", state: "done", detail: look },
  ];
  const resume = () => void api.speechSetupStart().then(refreshSetup).catch(toast.error);
  const pause = () => void api.speechSetupCancel().then(refreshSetup).catch(toast.error);
  return (
    <>
      <div className="setup-content">
        <span className="setup-done-mark">
          <Check size={22} strokeWidth={2.5} aria-hidden />
        </span>
        <SetupHead eyebrow="All set" title="Your library is ready">
          Here's where things stand. Anything still running or skipped waits for you on the Library page.
        </SetupHead>
        <div className="setup-summary">
          {rows.map((row) => (
            <div key={row.label} className={row.state === "running" && row.step === "speech" ? "setup-summary-row is-running" : "setup-summary-row"}>
              <StateIcon state={row.state} />
              <b>{row.label}</b>
              <span className="detail">
                {row.step === "speech" && speech === "running" ? (
                  <>
                    <span>
                      {install.phase === "runtime" ? "Setting up voice matching" : "Downloading speech models"}
                      {pct != null && ` · ${Math.round(install.done / 1e6)} of ${formatBytes(install.total)} · ${pct}%`}
                    </span>
                    <Bar pct={pct} />
                    <small>Recordings you add now are transcribed as soon as it finishes.</small>
                  </>
                ) : (
                  row.detail
                )}
              </span>
              {row.step === "speech" && speech === "running" ? (
                <Button size="sm" icon={Pause} onClick={pause}>
                  Pause
                </Button>
              ) : row.step === "speech" && (speech === "failed" || speech === "paused") ? (
                <Button size="sm" icon={Play} onClick={resume}>
                  {speech === "failed" ? "Try again" : "Resume"}
                </Button>
              ) : row.state === "skipped" || row.state === "todo" ? (
                <Button size="sm" variant="ghost" onClick={() => go(row.step)}>
                  Set up
                </Button>
              ) : (
                <span />
              )}
            </div>
          ))}
        </div>
      </div>
      <SetupFoot back={() => go("look")} primary={{ label: "Open my library", onClick: finish }} />
    </>
  );
}
