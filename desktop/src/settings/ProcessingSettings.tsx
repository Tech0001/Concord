import { useCallback, useEffect, useState } from "react";
import { Workflow } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { AutomaticSetup } from "../pipeline/AutomaticAi.tsx";
import { Setup } from "../pipeline/Setup.tsx";
import type { AutomaticAi, PipelineConfig } from "../pipeline/types.ts";
import "../pipeline/pipeline.css";
import { useApp } from "../shell/AppContext.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { DownloadSettings } from "./DownloadSettings.tsx";

/** How recordings are downloaded and processed, and what runs after transcription. */
export function ProcessingSettings() {
  const { device, setDevice } = useApp();
  const toast = useToast();
  const [config, setConfig] = useState<PipelineConfig>();
  const [automatic, setAutomatic] = useState<AutomaticAi>();
  const load = useCallback(async () => {
    try {
      const [state, ai] = await Promise.all([api.pipelineState(), api.pipelineAiState()]);
      setConfig(state.config);
      setAutomatic(ai);
    } catch (e) {
      toast.error(e);
    }
  }, [toast]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div id="settings-processing" className="settings-anchor">
      <section className="settings-section">
        <header>
          <span className="settings-icon">
            <Workflow size={17} aria-hidden />
          </span>
          <h2>Processing &amp; downloads</h2>
        </header>
        <div className="settings-body">
          {config ? (
            <Setup
              config={config}
              device={device}
              onSave={async (value) => {
                await api.pipelineSaveConfig(value);
                setDevice(value.device);
                await load();
              }}
            />
          ) : (
            <p className="muted">Loading…</p>
          )}
          {automatic && <AutomaticSetup state={automatic} onChanged={load} />}
        </div>
      </section>
      <DownloadSettings />
    </div>
  );
}
