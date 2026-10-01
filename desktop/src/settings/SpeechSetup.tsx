import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Square } from "lucide-react";
import { api } from "../lib/ipc.ts";
import type { SpeechSetupStatus } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";

export function SpeechSetup({ managed, onComplete }: { managed: boolean; onComplete: () => void }) {
  const toast = useToast();
  const [state, setState] = useState<SpeechSetupStatus>();
  const [starting, setStarting] = useState(false);
  const complete = useRef(onComplete); complete.current = onComplete;
  useEffect(() => {
    let disposed = false; let last = ""; let pending = false;
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await api.speechSetupStatus();
        if (!disposed) {
          setState(next);
          if (last === "running" && next.status !== "running") complete.current();
          last = next.status;
        }
      } catch (e) { if (!disposed) toast.error(e); }
      finally { pending = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const start = async () => {
    setStarting(true);
    try { await api.speechSetupStart(); setState(await api.speechSetupStatus()); }
    catch (e) { toast.error(e); }
    finally { setStarting(false); }
  };
  const running = starting || state?.status === "running";
  return <div className="speech-setup">
    <p>{managed ? "Speech is installed in Concord Next’s own folder." : "Prepare speech for this app without installing Electron or changing your system Python."} Transcription and diarization use your selected CPU or GPU. The portable voice matcher runs on CPU.</p>
    <p className="muted">Setup downloads about 950 MB of models plus voice-matching dependencies. Allow several GB of free space. Verified models are reused when you retry. Your recordings stay on this computer.</p>
    <div className="speech-setup-actions">
      <Button icon={running ? LoaderCircle : Download} disabled={running} onClick={() => void start()}>{running ? "Preparing speech…" : managed ? "Repair speech setup" : "Prepare speech"}</Button>
      {running && <Button variant="ghost" icon={Square} onClick={() => api.speechSetupCancel().catch(toast.error)}>Cancel setup</Button>}
    </div>
    {state?.message && <p role="status" className={state.status === "failed" ? "speech-setup-error" : "muted"}>{state.message}</p>}
    {state?.details && <details><summary>Setup log</summary><pre className="speech-setup-log">{state.details}</pre></details>}
  </div>;
}
