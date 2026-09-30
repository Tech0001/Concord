import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Activity, ArrowRight, CheckCircle2, Circle, Loader2, RefreshCw, Settings2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiRequest } from "@/lib/queryClient";
import { visibleModels } from "@/lib/transcription-models";
import { usePipelineSetup, refreshPipelineSetup } from "@/hooks/use-pipeline-setup";
import { useToast } from "@/hooks/use-toast";
import Pipeline from "./Pipeline";
import Settings, { PipelineSettingsCard } from "./Settings";
import TranscriptionSetup from "./TranscriptionSetup";

export default function PipelineHub({ section = "run" }: { section?: "run" | "setup" | "ai" }) {
  const [, navigate] = useLocation();
  const { data: setup, error, isFetching, refetch } = usePipelineSetup();
  const { toast } = useToast();
  const [finishing, setFinishing] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const active = section === "run" && !setup?.ready ? "setup" : section;
  const refresh = useCallback(() => {
    setRuntimeVersion(value => value + 1);
    void refreshPipelineSetup();
  }, []);

  const finish = async () => {
    setFinishing(true);
    try {
      await apiRequest("POST", "/api/pipeline/setup/complete", {});
      await refreshPipelineSetup();
      navigate("/pipeline");
      toast({ title: "Pipeline is ready", description: "Add a video or a channel when you are ready to start." });
    } catch (error) {
      toast({ variant: "destructive", title: "Setup needs attention", description: error instanceof Error ? error.message : String(error) });
      void refetch();
    } finally { setFinishing(false); }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold"><Activity className="h-5 w-5" />Pipeline</h1>
          <p className="mt-1 text-sm text-muted-foreground">Set up your processing, then manage channels, downloads, and transcripts here.</p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs">{setup?.ready ? "Ready to use" : "Setup required"}</span>
      </div>
      <nav className="flex flex-wrap gap-2 border-b pb-3" aria-label="Pipeline views">
        <Button variant={active === "run" ? "secondary" : "ghost"} disabled={!setup?.ready || installing} onClick={() => navigate("/pipeline")}><Activity className="mr-2 h-4 w-4" />Run pipeline</Button>
        <Button variant={active === "setup" ? "secondary" : "ghost"} disabled={installing} onClick={() => navigate("/pipeline/setup")}><Settings2 className="mr-2 h-4 w-4" />Setup</Button>
        <Button variant={active === "ai" ? "secondary" : "ghost"} disabled={installing} onClick={() => navigate("/pipeline/ai")}><Sparkles className="mr-2 h-4 w-4" />AI & extras</Button>
      </nav>

      {error && <Card><CardContent className="space-y-3 pt-5"><p>Could not check Pipeline setup. Reconnect to Concord and try again.</p><Button variant="outline" onClick={() => void refetch()}>Retry setup check</Button></CardContent></Card>}
      {!setup && !error && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Checking setup…</p>}

      {setup && active === "run" && <Pipeline />}
      {active === "ai" && <><p className="text-sm text-muted-foreground">Optional: connect AI for summaries and semantic search. You can finish the core Pipeline setup without a model server.</p><Settings /></>}
      {setup && active === "setup" && <div className="mx-auto max-w-4xl space-y-5">
        <Card>
          <CardHeader><CardTitle>{setup.ready ? "Pipeline configuration" : "Set up before your first run"}</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">Choose where your files go, review download preferences, and set up transcription. These settings also remain available here after setup.</p>
            <div className="grid gap-3 sm:grid-cols-3">
              {setup.checks.map((check, index) => <a key={check.id} href={check.id === "transcription" ? "#pipeline-transcription" : "#pipeline-storage"} className="rounded-lg border p-3 hover:bg-muted/40">
                <div className="flex items-center gap-2 text-sm font-medium">{check.ready ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <Circle className="h-4 w-4 text-muted-foreground" />}{index + 1}. {check.label}</div>
                <p className="mt-2 text-xs text-muted-foreground">{check.detail}</p>
              </a>)}
            </div>
          </CardContent>
        </Card>

        <section id="pipeline-storage" className="scroll-mt-4"><PipelineSettingsCard onSaved={refresh} /></section>

        <section id="pipeline-transcription" className="scroll-mt-4 space-y-3">
          <h2 className="text-base font-semibold">Transcription</h2>
          {setup.checks.find(check => check.id === "transcription")?.ready ? <details className="rounded-lg border p-4">
            <summary className="cursor-pointer text-sm font-medium">Current engine is available · install, change, or repair</summary>
            <TranscriptionSetup onInstalled={refresh} onBusyChange={setInstalling} />
          </details> : <TranscriptionSetup onInstalled={refresh} onBusyChange={setInstalling} />}
          <RuntimeSettings key={runtimeVersion} onSaved={refresh} disabled={installing} runtimeReady={!!setup.checks.find(check => check.id === "transcription")?.ready} />
        </section>

        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-5">
            <div className="max-w-lg text-sm"><p className="font-medium">{setup.requirementsMet ? "Your core setup is configured" : "Complete the required settings above"}</p><p className="mt-1 text-muted-foreground">AI and channel subscriptions can be added afterward. Finishing setup does not start any downloads.</p></div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={refresh} disabled={isFetching || installing}><RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />Check again</Button>
              <Button onClick={finish} disabled={!setup.requirementsMet || finishing || installing}>{finishing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ArrowRight className="mr-2 h-4 w-4" />}{setup.ready ? "Go to pipeline" : "Finish setup"}</Button>
            </div>
          </CardContent>
        </Card>
      </div>}
    </div>
  );
}

interface RuntimeConfig { model: string; device: string; computeType: string; engine?: "" | "nemo" | "parakeet" | "whisper" }

function RuntimeSettings({ onSaved, disabled, runtimeReady }: { onSaved: () => void; disabled: boolean; runtimeReady: boolean }) {
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [platform, setPlatform] = useState<NodeJS.Platform | null>(null);
  const [gpuPresent, setGpuPresent] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    Promise.all([apiRequest("GET", "/api/pipeline/config").then(r => r.json()), apiRequest("GET", "/api/transcription/status").then(r => r.json())])
      .then(([data, system]) => { if (!cancelled) { setConfig(data.transcription); setPlatform(system.platform); setGpuPresent(data.transcription.engine === "nemo" ? system.native?.device !== "cpu" && !!system.native?.available : system.gpu.present); setInstalled(system.installed || system.skipSetup); } })
      .catch(() => { if (!cancelled) setError("Could not load transcription settings. Use Check again to retry."); });
    return () => { cancelled = true; };
  }, []);
  if (!config) return error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null;
  // Installation applies a matching model/device together. Until then the
  // installer shows the recommended settings, without a second competing form.
  if (!installed && !runtimeReady) return null;
  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await apiRequest("POST", "/api/pipeline/config", { transcription: { model: config.model, device: config.device, computeType: config.computeType } });
      onSaved();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setSaving(false); }
  };
  return <Card>
    <CardHeader><CardTitle className="text-sm">Model & hardware</CardTitle></CardHeader>
    <CardContent className="space-y-4">
      {platform !== "darwin" && !gpuPresent && <p className="text-xs text-muted-foreground">CPU processing is available on this computer.</p>}
      <div className="grid gap-4 sm:grid-cols-3">
        <div><label className="mb-2 block text-xs" htmlFor="pipeline-model">Model</label><Select value={config.model} onValueChange={model => setConfig({ ...config, model })} disabled={disabled}><SelectTrigger id="pipeline-model"><SelectValue /></SelectTrigger><SelectContent>{visibleModels(platform, config.model, config.engine).map(model => <SelectItem key={model.value} value={model.value}>{model.label}</SelectItem>)}</SelectContent></Select></div>
        {platform !== "darwin" && <>
          <div><label className="mb-2 block text-xs" htmlFor="pipeline-device">Process on</label><Select value={config.device} onValueChange={device => setConfig({ ...config, device, computeType: config.engine === "nemo" ? "q8_0" : device === "cpu" ? "int8" : "float16" })} disabled={disabled}><SelectTrigger id="pipeline-device"><SelectValue /></SelectTrigger><SelectContent>{config.engine === "nemo" && <SelectItem value="auto">Automatic</SelectItem>}<SelectItem value="cpu">CPU</SelectItem><SelectItem value={config.engine === "nemo" ? "vulkan:0" : "cuda"} disabled={!gpuPresent}>{config.engine === "nemo" ? "GPU (Vulkan)" : "NVIDIA GPU"}{!gpuPresent ? " (not detected)" : ""}</SelectItem></SelectContent></Select></div>
          {config.engine !== "nemo" && <div><label className="mb-2 block text-xs" htmlFor="pipeline-compute">Compute type (Whisper)</label><Select value={config.computeType} onValueChange={computeType => setConfig({ ...config, computeType })} disabled={disabled || config.model.includes("parakeet")}><SelectTrigger id="pipeline-compute"><SelectValue /></SelectTrigger><SelectContent>{(config.device === "cpu" ? ["int8", "float32"] : ["float16", "int8", "float32"]).map(type => <SelectItem key={type} value={type}>{type}</SelectItem>)}</SelectContent></Select></div>}
        </>}
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button size="sm" variant="outline" onClick={save} disabled={saving || disabled}>{saving ? "Saving…" : "Save transcription settings"}</Button>
    </CardContent>
  </Card>;
}
