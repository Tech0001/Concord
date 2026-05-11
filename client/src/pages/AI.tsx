import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Eye, EyeOff, RefreshCw, Save, Sparkles, Database, Loader2, FileText, BookOpen, ChevronDown, ChevronUp } from "lucide-react";

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
    // Abort after 8s. oMLX serializes requests behind the active chat
    // completion; during a long summary-backfill batch, /v1/models can
    // queue for several seconds. 8s is forgiving enough to avoid noise
    // but still surfaces a truly-dead server within one poll cycle.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
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

      <SummariesCard hasChatModel={Boolean(chatModel || config?.chatModel)} />

      <ModelNamingCheatsheet />


      {status && !status.reachable && status.error && !/abort/i.test(status.error) && (
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

interface SummariesProgress {
  done: number;
  total: number;
  written: number;
  skipped: number;
  current?: string;
}

function SummariesCard({ hasChatModel }: { hasChatModel: boolean }) {
  const { toast } = useToast();
  const [progress, setProgress] = useState<SummariesProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [overwrite, setOverwrite] = useState(false);

  const generate = async () => {
    if (!hasChatModel) {
      toast({ title: "Pick + save a chat model first", variant: "destructive" });
      return;
    }
    setRunning(true);
    setProgress({ done: 0, total: 0, written: 0, skipped: 0 });
    try {
      const res = await fetch("/api/llm/summaries/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overwrite }),
      });
      if (!res.ok || !res.body) {
        const err = await res.text().catch(() => `HTTP ${res.status}`);
        throw new Error(err);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let written = 0;
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
            setProgress({ done: 0, total, written: 0, skipped: 0 });
          } else if (event === "video") {
            done = data.done;
            if (data.skipped) skipped++;
            else if (data.charsOut > 0) written++;
            setProgress({ done, total, written, skipped, current: data.videoId });
          } else if (event === "done") {
            setProgress({ done: data.total, total: data.total, written: data.written, skipped: data.skipped });
          }
        }
      }
      toast({
        title: "Summaries done",
        description: `${written} written, ${skipped} skipped`,
      });
    } catch (err) {
      toast({ title: "Summary generation failed", description: String(err), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileText className="h-4 w-4 text-muted-foreground" />
          AI summaries (per video)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground">
          Auto-generated 2-3 sentence summaries appear in each video's <strong>AI summary</strong> section
          (separate from your own notes — those are never touched). New transcripts get summarized
          automatically; this button backfills existing ones. Without <strong>Overwrite</strong>,
          videos that already have an AI summary from this same model are skipped — useful when
          you've changed model and want to refresh everything.
        </div>

        {progress && (
          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                {running && <Loader2 className="h-3 w-3 animate-spin" />}
                {running ? "Summarizing…" : "Done"}
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
              <span>{progress.written} written</span>
              {progress.skipped > 0 && <span>{progress.skipped} skipped</span>}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} disabled={running} />
            Overwrite existing AI summaries
          </label>
          <div className="ml-auto">
            <Button size="sm" onClick={generate} disabled={running || !hasChatModel}>
              {running
                ? <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                : <FileText className="mr-2 h-3 w-3" />}
              Generate summaries
            </Button>
          </div>
        </div>

        {!hasChatModel && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            Pick + save a chat model above to enable summary generation.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ReindexProgress {
  done: number;
  total: number;
  totalSegments: number;
  skipped: number;
  alreadyCovered?: number;
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
      let alreadyCovered = 0;
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
            alreadyCovered = data.alreadyCovered || 0;
            setProgress({ done: 0, total, totalSegments: 0, skipped: 0, alreadyCovered });
          } else if (event === "video") {
            done = data.done;
            if (data.skipped) skipped++;
            else totalSegments += (data.segmentCount || 0);
            setProgress({ done, total, totalSegments, skipped, alreadyCovered, current: data.videoId });
          } else if (event === "done") {
            setProgress({ done: data.total, total: data.total, totalSegments: data.totalSegments, skipped: data.skipped, alreadyCovered });
          }
        }
      }
      const description = total === 0
        ? `Nothing to do — all ${alreadyCovered} videos already indexed for this model.`
        : `${totalSegments} segments embedded across ${done - skipped} videos (${skipped} skipped${alreadyCovered ? `, ${alreadyCovered} already covered` : ""})`;
      toast({ title: "Reindex complete", description });
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
            <div className="mt-1.5 flex flex-wrap justify-between gap-x-3 text-muted-foreground">
              <span>{progress.totalSegments} segments embedded</span>
              <span className="flex gap-3">
                {progress.skipped > 0 && <span>{progress.skipped} skipped</span>}
                {progress.alreadyCovered ? <span>{progress.alreadyCovered} already covered</span> : null}
              </span>
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

/**
 * Reference card for understanding what the cryptic model names in oMLX
 * (and HuggingFace generally) actually mean. Collapsed by default —
 * users only need this when picking a model, not every time the page loads.
 */
function ModelNamingCheatsheet() {
  const [expanded, setExpanded] = useState(false);

  return (
    <Card>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between p-6 text-left hover:bg-muted/30"
      >
        <span className="flex items-center gap-2 text-sm font-medium">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          Model naming cheatsheet
        </span>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </button>

      {expanded && (
        <CardContent className="space-y-5 border-t pt-5 text-xs">

          <Section title="Anatomy of a model name">
            <p className="text-muted-foreground">Generic shape:</p>
            <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-[11px]">
              creator/Family-Version-Size-Variant-Quantization{"\n"}
              {"  "}mlx-community/Qwen3.5-9B-OptiQ-4bit
            </pre>
          </Section>

          <Section title="Family — who made the base">
            <CheatTable
              cols={["Tag", "Maker", "Notes"]}
              rows={[
                ["Qwen", "Alibaba", "Currently top open models. 2.5 / 3 / 3.5 / 3.6"],
                ["Llama", "Meta", "3.1, 3.2, 3.3"],
                ["DeepSeek", "DeepSeek", "R1 = reasoning specialist"],
                ["Gemma", "Google", "2, 3"],
                ["Mistral", "Mistral", "Mixtral = MoE variant"],
                ["Phi", "Microsoft", "Small, punches above weight"],
              ]}
            />
          </Section>

          <Section title="Size — params count">
            <p className="text-muted-foreground">
              <Code>4B</Code>, <Code>8B</Code>, <Code>14B</Code>, <Code>27B</Code>… = billions of parameters.
              Bigger = smarter + slower + more RAM.
            </p>
            <p className="text-muted-foreground">
              <strong className="text-foreground">MoE (Mixture-of-Experts):</strong> <Code>35B-A3B</Code> means
              35B total params with only 3B active per token. Disk size is the 35B; speed/RAM during inference is closer
              to the 3B. Cheaper to run than its size suggests.
            </p>
          </Section>

          <Section title="Variant — what it's tuned for">
            <CheatTable
              cols={["Suffix", "Means", "Good for", "Avoid for"]}
              rows={[
                ["(none) / -Base", "Foundation, not chat-tuned", "Fine-tuning your own", "Chat — won't follow instructions"],
                ["-Instruct / -Chat", "Follows instructions", "Summaries, tags, general chat — your default", "—"],
                ["-Coder", "Trained on code", "Code completion, debugging", "General prose"],
                ["-VL", "Vision-Language (multimodal)", "Image / OCR / diagrams", "Pure text (wastes weights)"],
                ["-Thinking / -R1", "Chain-of-thought reasoning", "Math, logic, multi-step RAG", "Summaries — overthinks"],
                ["-Distill / -UD", "Distilled from bigger teacher", "Smaller with bigger model's flavor", "—"],
              ]}
            />
          </Section>

          <Section title="Quantization — disk size vs quality">
            <CheatTable
              cols={["Tag", "Bits", "Quality vs FP16", "Use when"]}
              rows={[
                ["FP16 / no suffix", "16", "Reference", "100+ GB RAM"],
                ["-8bit", "8", "~99%", "Best quality, have RAM"],
                ["-6bit", "6", "~98%", "Sweet spot middle"],
                ["-5bit", "5", "~96%", "Tight RAM"],
                ["-4bit ★", "4", "~94-96%", "Default — best size/quality trade-off"],
                ["-3bit", "3", "Noticeable drop", "Desperate for RAM"],
                ["-DWQ", "4-ish, smarter", "~97%", "Pick over plain -4bit when both exist"],
                ["-OptiQ", "Variable", "Optimized scheme", "Newer, similar to DWQ"],
                ["-mxfp8", "8", "High", "Mac-specific, large"],
              ]}
            />
          </Section>

          <Section title="Format tag">
            <CheatTable
              cols={["Tag", "Means"]}
              rows={[
                ["MLX ★", "Compiled for Apple Silicon (uses ANE/Metal). Use these on Mac."],
                ["GGUF", "llama.cpp format. Cross-platform but slower on Mac."],
                ["safetensors (no tag)", "Raw weights, runs in PyTorch."],
              ]}
            />
            <p className="text-muted-foreground">For oMLX, always pick <Code>MLX</Code>.</p>
          </Section>

          <Section title="For Concord on this Mac">
            <CheatTable
              cols={["Task", "Pick", "Why"]}
              rows={[
                ["Per-video summary", "Qwen3.5-9B-MLX-4bit", "Fast, clean, instruction-following"],
                ["Tag suggestions", "Same as summary", "Categorization is simple — 9B is plenty"],
                ["Embeddings", "Qwen3-Embedding-0.6B-4bit-DWQ", "Right size, instruction-tuned, current default"],
                ["Future RAG", "Qwen3.5-27B-Instruct or DeepSeek-R1-Qwen3-8B", "Worth the reasoning overhead for multi-source citation"],
                ["Visual content", "Qwen3-VL-8B-Instruct-MLX-4bit", "Only if you ever need image understanding"],
              ]}
            />
          </Section>

          <Section title="Quick rules of thumb">
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
              <li>Always pick <Code>-Instruct</Code> / <Code>-Chat</Code> unless you're fine-tuning</li>
              <li>Always pick <Code>MLX</Code> on Mac (vs GGUF / safetensors)</li>
              <li>Default to <Code>-4bit</Code> or <Code>-DWQ</Code> — 99% as good for half the size</li>
              <li>Skip <Code>-Coder</Code> and <Code>-VL</Code> unless you specifically need code or images</li>
              <li>Skip <Code>-Thinking</Code> / <Code>-R1</Code> for summaries (overthinks); use them for RAG</li>
              <li>MoE (<Code>A3B</Code>) gives bigger-model quality on smaller-active-RAM</li>
              <li>Bigger ≠ always better — 9B-Instruct beats 27B-Thinking at summaries</li>
            </ul>
          </Section>

        </CardContent>
      )}
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">{children}</code>;
}

function CheatTable({ cols, rows }: { cols: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded border">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-muted/40">
            {cols.map((c) => (
              <th key={c} className="border-b px-2 py-1.5 text-left font-medium text-muted-foreground">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b last:border-b-0">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1.5 align-top">
                  {/^-?[A-Za-z0-9.+\- /★]{1,30}$/.test(cell) && j === 0
                    ? <span className="font-mono text-foreground">{cell}</span>
                    : <span className="text-muted-foreground">{cell}</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
