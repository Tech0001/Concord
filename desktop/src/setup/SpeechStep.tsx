import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, CircleAlert, Download, Info, LoaderCircle, Pause, Play, RefreshCw } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { cx } from "../lib/cx.ts";
import type { Runtime } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { formatBytes, speechPercent, speechState } from "./model.ts";
import { Bar, SetupFoot, SetupHead } from "./parts.tsx";
import type { StepProps } from "./steps.ts";
import type { Preflight } from "./types.ts";

const MODELS: [string, string, string, number][] = [
  ["Speech recognition", "Nemotron 3.5 ASR", "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", 741_548_352],
  ["Speaker separation", "Nemotron diarization", "Nemotron-3-Diarization.q8_0.gguf", 107_012_128],
  ["Voice matching", "TitaNet", "titanet-l.nemo", 101_621_760],
];
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

function Fact({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={cx("setup-fact", ok ? "is-ok" : "is-bad")}>
      {ok ? <Check size={15} aria-hidden /> : <CircleAlert size={15} aria-hidden />}
      {children}
    </span>
  );
}

/** Where speech runs. GPU maps to "auto" so a missing GPU later falls back to the processor. */
export function DevicePicker({ runtime }: { runtime?: Runtime }) {
  const { device, setDevice } = useApp();
  const gpu = runtime && runtime.runtimeReady !== false && runtime.device.startsWith("vulkan") ? runtime.gpu || "Graphics card" : null;
  const useGpu = device !== "cpu" && !!gpu;
  return (
    <section className="setup-section">
      <span className="setup-label" id="run-on">
        Run it on
      </span>
      <div className="setup-grid" role="radiogroup" aria-labelledby="run-on">
        <button type="button" role="radio" aria-checked={useGpu} className="setup-option" disabled={!gpu} onClick={() => setDevice("auto")}>
          <span className="setup-radio" />
          <span className="setup-option-text">
            <span className="setup-option-title">
              Graphics card {gpu && <span className="setup-badge is-ok">Detected</span>}
            </span>
            <span className="setup-option-desc">{gpu ? `${gpu} · Vulkan` : runtime ? "No compatible graphics card found" : "Checking for a graphics card…"}</span>
            <span className="setup-option-desc">Much faster on long recordings.</span>
          </span>
        </button>
        <button type="button" role="radio" aria-checked={!useGpu} className="setup-option" onClick={() => setDevice("cpu")}>
          <span className="setup-radio" />
          <span className="setup-option-text">
            <span className="setup-option-title">Processor only</span>
            <span className="setup-option-desc">Works on any computer</span>
            <span className="setup-option-desc">Slower, but always available.</span>
          </span>
        </button>
      </div>
    </section>
  );
}

export function SpeechStep({ status, next, skip, back, detour }: StepProps) {
  const { refreshSetup } = useApp();
  const toast = useToast();
  const [runtime, setRuntime] = useState<Runtime>();
  const [pre, setPre] = useState<Preflight>();
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    try {
      setPre(await api.setupPreflight());
    } catch (e) {
      toast.error(e);
    } finally {
      setChecking(false);
    }
  }, [toast]);
  useEffect(() => {
    api.speechStatus().then(setRuntime).catch(() => setRuntime(undefined));
    void check();
  }, [check]);

  const install = status.speech.setup;
  const state = speechState(status);
  const paused = state === "paused";
  const modelState = (name: string) => pre?.models.find((m) => m.name === name)?.state ?? "download";
  const reused = !!pre && pre.models.some((m) => m.state === "reusable");
  const total = !pre
    ? "About 950 MB of models, plus the runtime"
    : pre.downloadBytes === 0
      ? reused
        ? "Runtime only. Models are reused from the previous Concord app."
        : "Runtime only. The models are already installed."
      : pre.downloadBytes < pre.modelBytes
        ? `${mb(pre.downloadBytes)} of models, plus the runtime. The rest are reused from the previous Concord app.`
        : `About ${formatBytes(pre.modelBytes)} of models, plus the runtime`;
  const lowDisk = !!pre && pre.freeBytes != null && pre.freeBytes < pre.neededBytes;
  const blocked = !pre || lowDisk || !pre.network.ok || !pre.ffmpeg;
  const start = async (thenContinue: boolean) => {
    setStarting(true);
    try {
      await api.speechSetupStart();
      await refreshSetup();
      if (thenContinue) next();
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  const pause = () => void api.speechSetupCancel().then(refreshSetup).catch(toast.error);
  const showLog = async () => {
    if (log != null) return setLog(null);
    try {
      setLog((await api.speechSetupStatus()).details || "The setup log is empty.");
    } catch (e) {
      toast.error(e);
    }
  };
  const pct = speechPercent(install);
  const head = (
    <SetupHead eyebrow={detour ? "Speech engine" : "Step 2 of 5 · Recommended"} accent title="Install the speech engine">
      Transcription and speaker detection run entirely on this computer, so your recordings never leave it.
    </SetupHead>
  );

  if (state === "installed")
    return (
      <>
        <div className="setup-content">
          {head}
          <div className="setup-callout is-ok">
            <span className="setup-callout-icon">
              <Check size={20} aria-hidden />
            </span>
            <div className="setup-callout-body">
              <span className="setup-callout-title">The speech engine is installed</span>
              <span className="setup-callout-text">
                {status.speech.managed
                  ? "Models and voice matching live in Concord's own folder."
                  : "It's shared with the previous Concord app. Install Concord's own copy so transcription keeps working without it. Its models are reused."}
              </span>
              {!status.speech.managed && (
                <div className="setup-actions">
                  <Button icon={Download} disabled={starting} onClick={() => void start(false)}>
                    Install Concord's own copy
                  </Button>
                </div>
              )}
            </div>
          </div>
          <DevicePicker runtime={runtime} />
        </div>
        <SetupFoot back={back} primary={{ label: detour ? "Done" : "Continue", onClick: next }} />
      </>
    );

  return (
    <>
      <div className="setup-content">
        {head}
        <DevicePicker runtime={runtime} />
        <section className="setup-section">
          <span className="setup-label">What gets installed</span>
          <div className="setup-table">
            {MODELS.map(([name, detail, file, bytes]) => (
              <div className="setup-row" key={name}>
                <span>{name}</span>
                <span>{detail}</span>
                {modelState(file) === "download" ? (
                  <span className="setup-size">{mb(bytes)}</span>
                ) : (
                  <span className="setup-reused">
                    <Check size={14} aria-hidden />
                    {modelState(file) === "installed" ? "Installed" : "Already here"}
                  </span>
                )}
              </div>
            ))}
            <div className="setup-row">
              <span>Voice-matching runtime</span>
              <span>Python 3.12 + PyTorch (CPU)</span>
              <span className="setup-size">about {formatBytes(pre?.runtimeBytes ?? 2.2e9)}</span>
            </div>
            <div className="setup-row is-total">
              <span>Download</span>
              <span>{total}</span>
            </div>
          </div>
        </section>

        {state === "running" ? (
          <div className="setup-progress" role="status">
            <div className="setup-progress-head">
              <LoaderCircle size={16} className="spin" aria-hidden />
              {install.phase === "runtime" ? "Setting up voice matching" : "Downloading speech models"}
              {pct != null && (
                <span className="num">
                  {Math.round(install.done / 1e6)} of {formatBytes(install.total)} · {pct}%
                </span>
              )}
            </div>
            <Bar pct={pct} />
            <p>{install.message}</p>
            <div className="setup-actions">
              <Button size="sm" variant="ghost" icon={Pause} onClick={pause}>
                Pause
              </Button>
            </div>
          </div>
        ) : state === "failed" || paused ? (
          <div className={cx("setup-callout", !paused && "is-bad")}>
            <span className="setup-callout-icon">{paused ? <Pause size={20} aria-hidden /> : <CircleAlert size={20} aria-hidden />}</span>
            <div className="setup-callout-body">
              <span className="setup-callout-title">{paused ? "Setup is paused" : "Setup didn't finish"}</span>
              <span className="setup-callout-text">
                {paused
                  ? install.phase === "models" && install.done > 0
                    ? `${Math.round(install.done / 1e6)} of ${formatBytes(install.total)} downloaded. Resume to continue where it stopped.`
                    : "Resume to continue where it stopped."
                  : install.message || "Try again to continue."}
              </span>
              <div className="setup-actions">
                <Button icon={paused ? Play : RefreshCw} disabled={starting} onClick={() => void start(false)}>
                  {paused ? "Resume" : "Try again"}
                </Button>
                <Button variant="ghost" onClick={() => void showLog()}>
                  {log == null ? "Show log" : "Hide log"}
                </Button>
              </div>
              {log != null && <pre className="speech-setup-log">{log}</pre>}
            </div>
          </div>
        ) : (
          <div className="setup-facts" aria-live="polite">
            {!pre ? (
              <span className="setup-fact is-info">
                <LoaderCircle size={15} className="spin" aria-hidden />
                Checking disk space and your connection…
              </span>
            ) : (
              <>
                <Fact ok={pre.freeBytes != null && !lowDisk}>
                  {pre.freeBytes == null
                    ? "Couldn't check free space"
                    : lowDisk
                      ? `Needs about ${formatBytes(pre.neededBytes)} free. ${formatBytes(pre.freeBytes)} available.`
                      : `${formatBytes(pre.freeBytes)} free`}
                </Fact>
                <Fact ok={pre.network.ok}>{pre.network.ok ? "Download servers reachable" : pre.network.error}</Fact>
                {!pre.network.ok && (
                  <Button size="sm" icon={RefreshCw} disabled={checking} onClick={() => void check()}>
                    Check again
                  </Button>
                )}
                <Fact ok={pre.ffmpeg}>{pre.ffmpeg ? "ffmpeg found" : "ffmpeg is missing. Install it with your system's package manager."}</Fact>
                <span className="setup-fact is-info">
                  <Info size={15} aria-hidden />
                  Installs in the background. If Concord closes, it picks up where it stopped.
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <SetupFoot
        back={back}
        skip={state === "running" ? null : skip}
        primary={
          state === "running"
            ? { label: detour ? "Done" : "Continue", onClick: next }
            : state === "failed" || paused
              ? { label: detour ? "Done" : "Continue", onClick: next }
              : { label: "Install and continue", icon: Download, busy: starting, disabled: blocked, onClick: () => void start(true) }
        }
      />
    </>
  );
}
