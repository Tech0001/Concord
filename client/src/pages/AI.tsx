import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff, RefreshCw, Save, Sparkles, Database, Loader2 } from "lucide-react";

interface LlmConfig {
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  hasApiKey: boolean;
}

interface LlmStatus {
  reachable: boolean;
  latencyMs?: number;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  hasApiKey: boolean;
  error?: string;
  errorKind?: "config" | "unreachable" | "http";
  httpStatus?: number;
}

interface ProviderModel { id: string }

const PRESETS: { label: string; baseUrl: string }[] = [
  { label: "oMLX (Mac, default)", baseUrl: "http://localhost:8000/v1" },
  { label: "Ollama (Linux/Mac)", baseUrl: "http://localhost:11434/v1" },
];

// The HF repo is `mlx-community/Qwen3-Embedding-0.6B-4bit-DWQ` but oMLX
// serves it under the leaf name only (see GET /v1/models). Match what the
// runtime returns so picking "Recommended" produces an API-callable id.
const SUGGESTED_EMBEDDING_MODEL = "Qwen3-Embedding-0.6B-4bit-DWQ";

export default function AI() {
  const { toast } = useToast();
  const [config, setConfig] = useState<LlmConfig | null>(null);
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [models, setModels] = useState<ProviderModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyEdited, setApiKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [chatModel, setChatModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");

  const [saving, setSaving] = useState(false);
  const [probingModels, setProbingModels] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const r = await apiRequest("GET", "/api/llm/config");
      const c: LlmConfig = await r.json();
      setConfig(c);
      setBaseUrl(c.baseUrl);
      setChatModel(c.chatModel);
      setEmbeddingModel(c.embeddingModel);
      setApiKey("");
      setApiKeyEdited(false);
    } catch (err) {
      toast({ title: "Failed to load LLM config", description: String(err), variant: "destructive" });
    }
  }, [toast]);

  // No deps on baseUrl/chatModel/embeddingModel — those would re-create
  // fetchStatus on every keystroke, retriggering the mount effect and
  // clobbering the form mid-edit. The fallback uses empty strings; the
  // happy path always returns the server's authoritative view anyway.
  const fetchStatus = useCallback(async () => {
    // Abort after 3s — a dead server otherwise hangs the poll for minutes
    // (TCP timeout), accumulating pending fetches every 10s.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch("/api/llm/status", { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
    } catch (err) {
      setStatus({
        reachable: false,
        baseUrl: "",
        chatModel: "",
        embeddingModel: "",
        hasApiKey: false,
        error: String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const probeModels = useCallback(async () => {
    setProbingModels(true);
    setModelsError(null);
    try {
      const r = await fetch("/api/llm/models");
      const data = await r.json();
      if (!r.ok) {
        setModelsError(data.error || `HTTP ${r.status}`);
        setModels([]);
      } else {
        setModels(data.models || []);
      }
    } catch (err) {
      setModelsError(String(err));
      setModels([]);
    } finally {
      setProbingModels(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchStatus();
    probeModels();
    const id = setInterval(fetchStatus, 10000);
    return () => clearInterval(id);
  }, [fetchConfig, fetchStatus, probeModels]);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, string> = {
        baseUrl,
        chatModel,
        embeddingModel,
      };
      // Only send apiKey if the user actually edited the field.
      // Sending empty string would clear an existing key on every save.
      if (apiKeyEdited) body.apiKey = apiKey;
      const r = await apiRequest("POST", "/api/llm/config", body);
      const data = await r.json();
      setConfig(data.config);
      setApiKey("");
      setApiKeyEdited(false);
      toast({ title: "LLM config saved" });
      // Re-probe everything after saving so the user sees fresh state immediately.
      fetchStatus();
      probeModels();
    } catch (err) {
      toast({ title: "Save failed", description: String(err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    if (!config?.hasApiKey) return;
    if (!confirm("Clear the saved API key?")) return;
    try {
      await apiRequest("POST", "/api/llm/config", { apiKey: "" });
      toast({ title: "API key cleared" });
      fetchConfig();
      fetchStatus();
    } catch (err) {
      toast({ title: "Failed to clear key", description: String(err), variant: "destructive" });
    }
  };

  const statusDot = (() => {
    if (!status) return "bg-muted";
    if (status.reachable) return "bg-emerald-500";
    if (status.errorKind === "http") return "bg-amber-500";
    return "bg-zinc-500";
  })();

  const statusLabel = (() => {
    if (!status) return "checking…";
    if (status.reachable) {
      return `reachable${status.latencyMs !== undefined ? ` (${status.latencyMs}ms)` : ""}`;
    }
    switch (status.errorKind) {
      case "config":      return "not configured";
      case "unreachable": return "unreachable";
      case "http":        return `HTTP ${status.httpStatus ?? ""}`.trim();
      default:            return "error";
    }
  })();

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4">
      <div className="flex items-center gap-3">
        <Sparkles className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-xl font-semibold">AI</h1>
        <div className="ml-auto flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-xs">
          <span className={`inline-block h-2 w-2 rounded-full ${statusDot}`} />
          <span className="text-muted-foreground">{statusLabel}</span>
          <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => { fetchStatus(); probeModels(); }} aria-label="Re-probe">
            <RefreshCw className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Provider</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-[160px_1fr] items-center gap-3">
            <label className="text-sm text-muted-foreground">Base URL</label>
            <div className="flex gap-2">
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="http://localhost:8000/v1"
                className="font-mono text-xs"
              />
              <Select value="" onValueChange={(v) => setBaseUrl(v)}>
                <SelectTrigger className="w-[200px] text-xs">
                  <SelectValue placeholder="Preset" />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.baseUrl} value={p.baseUrl} className="text-xs">{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className="text-sm text-muted-foreground">API key</label>
            <div className="flex gap-2">
              <Input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setApiKeyEdited(true); }}
                placeholder={config?.hasApiKey ? "•••••••• (saved — leave blank to keep)" : "(blank = no auth header)"}
                className="font-mono text-xs"
                autoComplete="off"
              />
              <Button size="icon" variant="ghost" onClick={() => setShowKey(s => !s)} aria-label={showKey ? "Hide" : "Show"}>
                {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              {config?.hasApiKey && (
                <Button size="sm" variant="outline" onClick={clearKey}>Clear</Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm">Models</CardTitle>
          <Button size="sm" variant="outline" onClick={probeModels} disabled={probingModels}>
            <RefreshCw className={`mr-2 h-3 w-3 ${probingModels ? "animate-spin" : ""}`} />
            Refresh list
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {modelsError && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
              Couldn't list models: {modelsError}. You can still type a model name manually below.
            </div>
          )}
          <div className="grid grid-cols-[160px_1fr] items-center gap-3">
            <label className="text-sm text-muted-foreground">Chat model</label>
            <ModelPicker
              value={chatModel}
              onChange={setChatModel}
              models={models}
              placeholder="e.g. qwen3-7b-instruct-4bit-mlx"
            />
            <label className="pt-2 text-sm text-muted-foreground">Embedding model</label>
            <div className="space-y-1.5">
              <ModelPicker
                value={embeddingModel}
                onChange={setEmbeddingModel}
                models={models}
                placeholder={`e.g. ${SUGGESTED_EMBEDDING_MODEL}`}
              />
              {embeddingModel !== SUGGESTED_EMBEDDING_MODEL && (
                <div className="text-xs text-muted-foreground">
                  Recommended for spoken-word transcripts:{" "}
                  <button
                    type="button"
                    onClick={() => setEmbeddingModel(SUGGESTED_EMBEDDING_MODEL)}
                    className="font-mono text-foreground underline-offset-2 hover:underline"
                  >
                    {SUGGESTED_EMBEDDING_MODEL}
                  </button>
                  . Pull it from oMLX's HuggingFace browser if it isn't in the list above.
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => fetchConfig()} disabled={saving}>Reset</Button>
        <Button onClick={save} disabled={saving}>
          <Save className="mr-2 h-3 w-3" />
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>

      <EmbeddingsCard hasEmbeddingModel={Boolean(embeddingModel || config?.embeddingModel)} />


      {status && !status.reachable && status.error && (
        <div className="rounded-md border border-zinc-500/30 bg-card px-3 py-2 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">Last probe error</div>
          <div className="mt-1 break-all font-mono">{status.error}</div>
          {status.errorKind === "unreachable" && (
            <div className="mt-2 text-muted-foreground">
              Make sure your LLM server is running at <code>{status.baseUrl}</code>. For oMLX, launch the
              app and check it's serving on this URL. For Ollama, verify <code>ollama serve</code> is up.
            </div>
          )}
          {status.errorKind === "http" && status.httpStatus === 401 && (
            <div className="mt-2 text-muted-foreground">
              Server requires an API key. Paste it in the API key field above and Save.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelPicker(props: {
  value: string;
  onChange: (v: string) => void;
  models: ProviderModel[];
  placeholder: string;
}) {
  const { value, onChange, models, placeholder } = props;
  const knownIds = new Set(models.map((m) => m.id));
  const showSelect = models.length > 0;

  return (
    <div className="flex gap-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      {showSelect && (
        <Select value={knownIds.has(value) ? value : ""} onValueChange={onChange}>
          <SelectTrigger className="w-[260px] text-xs">
            <SelectValue placeholder="Pick from server" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs font-mono">{m.id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

interface EmbeddingStats {
  models: { model: string; videos: number; segments: number }[];
  totalSegments: number;
  totalVideos: number;
}

interface ReindexProgress {
  done: number;
  total: number;
  totalSegments: number;
  skipped: number;
  current?: string;
}

function EmbeddingsCard({ hasEmbeddingModel }: { hasEmbeddingModel: boolean }) {
  const { toast } = useToast();
  const [stats, setStats] = useState<EmbeddingStats | null>(null);
  const [progress, setProgress] = useState<ReindexProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [wipe, setWipe] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const r = await apiRequest("GET", "/api/llm/embeddings/stats");
      setStats(await r.json());
    } catch {
      setStats(null);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const reindex = async () => {
    if (!hasEmbeddingModel) {
      toast({ title: "Pick + save an embedding model first", variant: "destructive" });
      return;
    }
    setRunning(true);
    setProgress({ done: 0, total: 0, totalSegments: 0, skipped: 0 });
    try {
      const res = await fetch("/api/llm/embeddings/reindex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wipe }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(err);
      }
      // Parse SSE stream by hand — saves a dependency for one-off use.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let totalSegments = 0;
      let skipped = 0;
      let total = 0;
      let done = 0;
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const eventMatch = chunk.match(/^event: (.+)$/m);
          const dataMatch = chunk.match(/^data: (.+)$/m);
          if (!eventMatch || !dataMatch) continue;
          const event = eventMatch[1];
          const data = JSON.parse(dataMatch[1]);
          if (event === "start") {
            total = data.total;
            setProgress({ done: 0, total, totalSegments: 0, skipped: 0 });
          } else if (event === "video") {
            done = data.done;
            if (data.skipped) skipped++;
            else totalSegments += (data.segmentCount || 0);
            setProgress({ done, total, totalSegments, skipped, current: data.videoId });
          } else if (event === "done") {
            setProgress({ done: data.total, total: data.total, totalSegments: data.totalSegments, skipped: data.skipped });
          }
        }
      }
      toast({
        title: "Reindex complete",
        description: `${totalSegments} segments embedded across ${done - skipped} videos (${skipped} skipped)`,
      });
      fetchStats();
    } catch (err) {
      toast({ title: "Reindex failed", description: String(err), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Database className="h-4 w-4 text-muted-foreground" />
          Semantic search index
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={fetchStats}>
          <RefreshCw className="h-3 w-3" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {stats && stats.models.length === 0 && (
          <div className="text-xs text-muted-foreground">
            No embeddings stored yet. Run a reindex below to populate the semantic search index from existing transcripts.
          </div>
        )}
        {stats && stats.models.length > 0 && (
          <div className="space-y-1 text-xs">
            <div className="text-muted-foreground">Stored vectors:</div>
            {stats.models.map((m) => (
              <div key={m.model} className="flex items-baseline justify-between rounded border bg-muted/30 px-2 py-1">
                <code className="font-mono">{m.model}</code>
                <span className="text-muted-foreground">{m.videos} videos · {m.segments} segments</span>
              </div>
            ))}
          </div>
        )}

        {progress && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                {running && <Loader2 className="h-3 w-3 animate-spin" />}
                {running ? "Embedding…" : "Done"}
              </span>
              <span className="font-mono tabular-nums text-foreground">
                {progress.done} / {progress.total || "?"}
              </span>
            </div>
            <div className="h-1 overflow-hidden rounded bg-secondary">
              <div
                className="h-full bg-foreground transition-[width]"
                style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : "0%" }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-muted-foreground">
              <span>{progress.totalSegments} segments embedded</span>
              {progress.skipped > 0 && <span>{progress.skipped} skipped</span>}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} disabled={running} />
            Wipe existing first
          </label>
          <div className="ml-auto">
            <Button size="sm" onClick={reindex} disabled={running || !hasEmbeddingModel}>
              {running
                ? <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                : <Database className="mr-2 h-3 w-3" />}
              Reindex semantics
            </Button>
          </div>
        </div>

        {!hasEmbeddingModel && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            Pick + save an embedding model above to enable reindex.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
