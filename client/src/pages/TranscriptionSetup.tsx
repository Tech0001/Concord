import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { AlertCircle, CheckCircle2, Cpu, Loader2, Settings as SettingsIcon, SkipForward } from "lucide-react";

/** Mirror of server/transcription-setup.ts SetupStatus. */
interface SetupStatus {
  platform: string;
  skipSetup: boolean;
  python: { ok: boolean; path: string; version: string | null; error?: string };
  gpu: { present: boolean; name?: string; vramMb?: number; error?: string };
  recommendedEngine: "parakeet" | "whisper";
  venv: { path: string; exists: boolean; engine: "parakeet" | "whisper" | null };
  installed: boolean;
}

interface ProgressLine { phase: string; line: string }

const SKIP_FLAG = "concord-skip-transcription-setup";

export default function TranscriptionSetup() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<ProgressLine[]>([]);
  const [done, setDone] = useState<{ ok: boolean; engine?: string; error?: string } | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);
  // Power-user toggle to surface BOTH engine cards. Default off so the
  // common path is one button click on the recommended engine.
  const [showAllEngines, setShowAllEngines] = useState(false);

  // Auto-scroll the install log to the bottom on each new line.
  useEffect(() => {
    const el = logBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [progress.length]);

  const loadStatus = useCallback(async () => {
    try {
      const r = await apiRequest("GET", `/api/transcription/status?t=${Date.now()}`);
      setStatus(await r.json());
    } catch (err: any) {
      toast({ variant: "destructive", title: "Status check failed", description: err.message });
    }
  }, [toast]);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const skipSetup = () => {
    localStorage.setItem(SKIP_FLAG, "1");
    navigate("/");
  };

  const startInstall = async (engine: "parakeet" | "whisper") => {
    setInstalling(true);
    setProgress([]);
    setDone(null);

    // POST + SSE: server streams data: {phase, line} events. Use fetch +
    // body reader — EventSource doesn't support POST.
    try {
      const res = await fetch("/api/transcription/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ engine }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Install failed to start (HTTP ${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        // Parse SSE: data: <json>\n\n
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.phase === "complete") {
                setDone({ ok: !!event.ok, engine: event.engine, error: event.error });
              } else {
                setProgress(prev => [...prev, { phase: String(event.phase), line: String(event.line) }]);
              }
            } catch { /* malformed line, skip */ }
          }
        }
      }
    } catch (err: any) {
      setDone({ ok: false, error: err.message });
    } finally {
      setInstalling(false);
      // Refresh status so the "installed" flag flips after success.
      void loadStatus();
    }
  };

  if (!status) {
    return (
      <div className="flex h-[calc(100vh-12rem)] items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Probing system…
      </div>
    );
  }

  if (status.skipSetup) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Transcription is already bundled on this platform</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>FluidAudio ships with the macOS build — no Python venv setup needed.</p>
            <Button onClick={() => navigate("/")}>Continue to Library</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (done?.ok) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CheckCircle2 className="h-4 w-4 text-emerald-500" />
              {done.engine ? `${done.engine} installed` : "Engine installed"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p>Transcription is ready. New downloads (and retranscribes) will use the {done.engine} engine.</p>
            <p className="text-xs text-muted-foreground">
              You can swap engines later from Settings → Transcription.
            </p>
            <Button onClick={() => navigate("/")}>Continue</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const recommended = status.recommendedEngine;

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Set up transcription</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          {/* Detection summary */}
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <DetectRow
              label="Python"
              ok={status.python.ok}
              detail={status.python.version || status.python.error || "not found"}
            />
            <DetectRow
              label="GPU"
              ok={status.gpu.present}
              detail={
                status.gpu.present
                  ? `${status.gpu.name || "NVIDIA"} (${Math.round((status.gpu.vramMb ?? 0) / 1024)}GB)`
                  : status.gpu.error || "no NVIDIA GPU"
              }
              neutral={!status.gpu.present}
            />
          </div>

          {/* Recommendation banner */}
          <div className="rounded-md border bg-muted/30 p-3 text-xs">
            <div className="flex items-center gap-2">
              <Cpu className="h-3.5 w-3.5" />
              <span className="font-medium">Recommended for your machine: </span>
              <Badge variant="secondary">{recommended}</Badge>
            </div>
            <p className="mt-1 text-muted-foreground">
              {recommended === "parakeet"
                ? "NVIDIA GPU detected with enough VRAM — parakeet is the fastest option (≈100x realtime)."
                : status.gpu.present
                  ? "GPU is below the 8GB VRAM floor needed for parakeet — Whisper runs comfortably here."
                  : "No NVIDIA GPU detected — Whisper runs on CPU. Slower but works on any machine."}
            </p>
          </div>

          {/* Python error gate */}
          {!status.python.ok && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
              <div className="flex items-center gap-2 font-medium">
                <AlertCircle className="h-3.5 w-3.5" /> Python ≥ 3.10 required
              </div>
              <p className="mt-1 text-amber-900/80 dark:text-amber-200/80">
                Install with <code className="rounded bg-amber-500/10 px-1 py-0.5">sudo apt install python3.12 python3.12-venv</code>, then re-open this page.
              </p>
            </div>
          )}

          {/* Install button(s) — single big button when showing the
              recommended engine; two side-by-side cards when the user
              has opted into the manual override. */}
          {showAllEngines ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <EngineCard
                engine="parakeet"
                size="~5GB"
                speed="≈100x realtime"
                requirements="NVIDIA GPU, ≥8GB VRAM"
                disabled={!status.python.ok || installing}
                installing={installing}
                isRecommended={recommended === "parakeet"}
                onInstall={() => startInstall("parakeet")}
              />
              <EngineCard
                engine="whisper"
                size="~1.5GB"
                speed="varies (≈3–10x realtime)"
                requirements="any CPU; CUDA accelerates"
                disabled={!status.python.ok || installing}
                installing={installing}
                isRecommended={recommended === "whisper"}
                onInstall={() => startInstall("whisper")}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                size="lg"
                disabled={!status.python.ok || installing}
                onClick={() => startInstall(recommended)}
              >
                {installing
                  ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Installing {recommended}…</>
                  : <>Install {recommended} ({recommended === "parakeet" ? "~5GB" : "~1.5GB"})</>}
              </Button>
              <Button variant="ghost" size="sm" onClick={skipSetup} disabled={installing}>
                <SkipForward className="mr-1 h-3.5 w-3.5" /> Skip for now
              </Button>
            </div>
          )}

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Will install to <code>{status.venv.path}</code>. First-time install pulls wheels from PyPI; needs internet.</span>
            <button
              type="button"
              className="underline-offset-2 hover:underline"
              onClick={() => setShowAllEngines((v) => !v)}
              disabled={installing}
            >
              {showAllEngines ? "Use recommended only" : "Show both engines"}
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Live install log */}
      {(installing || progress.length > 0 || done) && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              {installing
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : done?.ok
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  : done && !done.ok
                    ? <AlertCircle className="h-4 w-4 text-red-500" />
                    : <Cpu className="h-4 w-4" />}
              Install log
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div
              ref={logBoxRef}
              className="max-h-72 overflow-y-auto rounded border bg-muted/30 p-2 font-mono text-[11px] leading-snug"
            >
              {progress.map((p, i) => (
                <div key={i} className="whitespace-pre-wrap">
                  <span className="mr-2 text-muted-foreground">[{p.phase}]</span>
                  {p.line}
                </div>
              ))}
              {progress.length === 0 && <div className="text-muted-foreground">Waiting for output…</div>}
            </div>
            {done && !done.ok && (
              <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2 text-xs text-red-900 dark:text-red-200">
                <div className="font-medium">Install failed</div>
                <p className="mt-1">{done.error}</p>
                <p className="mt-2 text-[11px]">Common fixes: <code>sudo apt install python3-venv libsndfile1</code>, then retry.</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => startInstall(recommended)}>
                  Retry
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Footer help */}
      <div className="flex items-center justify-end text-xs text-muted-foreground">
        <SettingsIcon className="mr-1 h-3 w-3" />
        Switch engines or repair install later from Settings → Transcription.
      </div>
    </div>
  );
}

function DetectRow({ label, ok, detail, neutral }: { label: string; ok: boolean; detail: string; neutral?: boolean }) {
  const color = neutral
    ? "bg-muted-foreground/40"
    : ok
      ? "bg-emerald-500"
      : "bg-red-500";
  return (
    <div className="flex items-center gap-2 rounded border p-2">
      <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
      <span className="font-medium">{label}</span>
      <span className="ml-auto truncate text-muted-foreground" title={detail}>{detail}</span>
    </div>
  );
}

interface EngineCardProps {
  engine: "parakeet" | "whisper";
  size: string;
  speed: string;
  requirements: string;
  isRecommended: boolean;
  installing: boolean;
  disabled: boolean;
  onInstall: () => void;
}

function EngineCard({ engine, size, speed, requirements, isRecommended, installing, disabled, onInstall }: EngineCardProps) {
  return (
    <div className={`flex flex-col gap-2 rounded-md border p-3 ${isRecommended ? "border-primary/40 bg-primary/5" : ""}`}>
      <div className="flex items-center justify-between">
        <div className="font-semibold capitalize">{engine}</div>
        {isRecommended && <Badge variant="secondary" className="text-[10px]">Recommended</Badge>}
      </div>
      <ul className="space-y-1 text-[11px] text-muted-foreground">
        <li>Install size: {size}</li>
        <li>Speed: {speed}</li>
        <li>Requires: {requirements}</li>
      </ul>
      <Button size="sm" disabled={disabled} onClick={onInstall} className="mt-auto">
        {installing
          ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Installing…</>
          : <>Install {engine}</>}
      </Button>
    </div>
  );
}
