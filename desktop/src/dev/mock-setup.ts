// Dev-only setup state for ?mock. Pick a starting point with ?setup=fresh|legacy|installing|failed|checklist|connected.
import type { SetupStatus } from "../setup/types.ts";

const params = new URLSearchParams(location.search);
const MODELS = 950_182_240;
const SEARCH_MODEL = 639_150_592;
const scenario = params.get("setup") ?? (params.has("empty-library") ? "fresh" : "upgrade");

function initial(): SetupStatus {
  const s: SetupStatus = {
    progress: { step: "library", furthest: "library", completed: false, skipped: [], checklistHidden: false },
    library: { started: true, imported: false, media: 48, docs: 5, notes: 6, dataRoot: "/home/you/.local/share/concord-next" },
    legacy: null,
    speech: { installed: true, managed: true, device: "auto", setup: { status: "complete", message: "Speech is ready.", phase: "runtime", done: 0, total: 0 } },
    sources: { sources: 1, documentFolders: 2 },
    search: { kind: "builtin", enabled: true, modelReady: true, download: { status: "complete", message: "", done: SEARCH_MODEL, total: SEARCH_MODEL } },
    chat: { kind: "local", enabled: false, model: "", connected: false },
  };
  const empty = { media: 0, docs: 0, notes: 0 };
  const missing = { installed: false, managed: false, device: "auto", setup: { status: "", message: "", phase: "", done: 0, total: 0 } };
  const noSearch = { kind: "builtin", enabled: true, modelReady: false, download: { status: "", message: "", done: 0, total: SEARCH_MODEL } };
  switch (scenario) {
    case "legacy":
    case "fresh":
      s.library = { ...s.library, ...empty, started: false };
      s.speech = missing;
      s.sources = { sources: 0, documentFolders: 0 };
      s.search = noSearch;
      if (scenario === "legacy")
        s.legacy = {
          path: "/home/you/.local/share/concord/pipeline.db",
          folder: "/home/you/.local/share/concord",
          recordings: 1284,
          speakers: 46,
          notes: 312,
          speechModelsReusable: true,
        };
      break;
    case "installing":
    case "checklist":
      s.library = { ...s.library, ...empty };
      s.progress = scenario === "installing"
        ? { ...s.progress, step: "recordings", furthest: "recordings" }
        : { ...s.progress, step: "ready", furthest: "ready", completed: true, skipped: ["recordings", "ai"] };
      s.speech = { ...missing, setup: { status: "running", message: "Downloading nemotron-3.5-asr-streaming-0.6b.q8_0.gguf · 361 / 741 MB", phase: "models", done: scenario === "installing" ? 115_000_000 : 608_000_000, total: MODELS } };
      s.sources = { sources: 0, documentFolders: 0 };
      s.search = { ...noSearch, download: { status: "waiting", message: "Waiting for the speech engine to finish", done: 0, total: SEARCH_MODEL } };
      break;
    case "failed":
      s.library = { ...s.library, ...empty };
      s.progress = { ...s.progress, step: "ready", furthest: "ready", completed: true };
      s.speech = { ...missing, setup: { status: "failed", message: "No space left on device while downloading nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", phase: "models", done: 420_000_000, total: MODELS } };
      s.search = noSearch;
      s.sources = { sources: 0, documentFolders: 0 };
      break;
    case "connected":
      s.progress = { ...s.progress, step: "ready", furthest: "ready", completed: true };
      s.chat = { kind: "openrouter", enabled: true, model: "meta-llama/llama-4-scout", connected: true };
      break;
  }
  return s;
}

export const setupState = initial();
const s = setupState;

/** Advance simulated downloads each time the UI polls. */
function tick() {
  const speech = s.speech.setup;
  if (speech.status === "running") {
    if (speech.phase === "models") {
      speech.done = Math.min(MODELS, speech.done + 38_000_000);
      speech.message = `Downloading nemotron-3.5-asr-streaming-0.6b.q8_0.gguf · ${Math.round(speech.done / 1e6)} / 741 MB`;
      if (speech.done >= MODELS) Object.assign(speech, { phase: "runtime", done: 0, total: 0, message: "Installing CPU-capable voice matching · this can take several minutes" });
    } else if (Math.random() < 0.25) {
      Object.assign(speech, { status: "complete", message: "Speech is ready." });
      s.speech.installed = true;
      s.speech.managed = true;
    }
  }
  const search = s.search.download;
  if (search.status === "waiting" && speech.status !== "running") Object.assign(search, { status: "running", message: "Downloading search model" });
  if (search.status === "running") {
    search.done = Math.min(SEARCH_MODEL, search.done + 48_000_000);
    if (search.done >= SEARCH_MODEL) {
      Object.assign(search, { status: "complete", message: "Search model downloaded" });
      s.search.modelReady = true;
    }
  }
}

const preflight = params.get("preflight");
const chatModels = [
  { id: "meta-llama/llama-4-scout", name: "Llama 4 Scout" },
  { id: "mistralai/mistral-small-3.2", name: "Mistral Small 3.2" },
];

export const setupHandlers: Record<string, (a: any) => unknown> = {
  setup_status: () => {
    tick();
    return structuredClone(s);
  },
  setup_save: ({ patch }) => {
    const p = s.progress;
    const order = ["library", "speech", "recordings", "ai", "look", "ready"];
    if (patch.step) {
      p.step = patch.step;
      if (order.indexOf(patch.step) > order.indexOf(p.furthest)) p.furthest = patch.step;
    }
    if (patch.completed != null) p.completed = patch.completed;
    if (patch.skipped) p.skipped = patch.skipped;
    if (patch.checklistHidden != null) p.checklistHidden = patch.checklistHidden;
    return structuredClone(p);
  },
  setup_preflight: () => ({
    freeBytes: preflight === "lowdisk" ? 3_100_000_000 : 186_400_000_000,
    freeError: null,
    neededBytes: (s.legacy?.speechModelsReusable ? 0 : MODELS) + 4_400_000_000,
    downloadBytes: s.legacy?.speechModelsReusable ? 0 : MODELS,
    modelBytes: MODELS,
    runtimeBytes: 2_200_000_000,
    ffmpeg: preflight !== "noffmpeg",
    network: preflight === "offline" ? { ok: false, error: "Can't reach huggingface.co. Check your connection." } : { ok: true, error: null },
  }),
  setup_probe_local: () => (params.has("no-ollama") ? [] : [{ kind: "ollama", baseUrl: "http://127.0.0.1:11434/v1", models: 3 }]),
  speech_device: () => s.speech.device,
  set_speech_device: ({ device }) => {
    s.speech.device = device;
  },
  speech_setup_status: () => {
    tick();
    return { ...s.speech.setup, details: "" };
  },
  speech_setup_start: () => {
    s.speech.setup = { status: "running", message: "Preparing speech setup", phase: "models", done: s.legacy?.speechModelsReusable ? MODELS - 38_000_000 : 0, total: MODELS };
  },
  speech_setup_cancel: () => {
    s.speech.setup = { ...s.speech.setup, status: "cancelled", message: "Setup cancelled" };
  },
  speech_status: () => ({
    ready: s.speech.installed,
    managed: s.speech.managed,
    runtimeReady: true,
    device: "vulkan:0",
    gpu: params.has("no-gpu") ? undefined : "NVIDIA GeForce RTX 2080 Ti",
    modelsReady: s.speech.installed,
    voiceMatchingReady: s.speech.installed,
    model: "nemotron",
    models: "",
    python: "",
  }),
  ai_builtin_status: () => {
    tick();
    return s.search.download;
  },
  ai_builtin_prepare: ({ afterSpeech }) => {
    s.search.download = { status: afterSpeech && s.speech.setup.status === "running" ? "waiting" : "running", message: "", done: 0, total: SEARCH_MODEL };
  },
  ai_builtin_cancel: () => {
    s.search.download = { ...s.search.download, status: "cancelled" };
  },
  ai_config: () => ({
    embedding: { enabled: s.search.enabled, kind: s.search.kind, model: s.search.kind === "builtin" ? "Qwen3-Embedding-0.6B-Q8_0" : "nomic-embed-text", baseUrl: "http://127.0.0.1", hasKey: false, local: true },
    chat: { enabled: s.chat.enabled, kind: s.chat.kind, model: s.chat.model, baseUrl: s.chat.kind === "openrouter" ? "https://openrouter.ai/api/v1" : "http://127.0.0.1:11434/v1", hasKey: s.chat.kind === "openrouter", local: s.chat.kind === "local", connected: s.chat.connected },
  }),
  ai_save_provider: ({ task, provider }) => {
    if (task === "embedding") s.search = { ...s.search, kind: provider.kind, enabled: provider.enabled, modelReady: provider.kind !== "builtin" || s.search.download.status === "complete" };
    else s.chat = { kind: provider.kind, enabled: provider.enabled, model: provider.model, connected: provider.enabled && !!provider.model };
    return setupHandlers.ai_config({});
  },
  ai_models: ({ task }) => (task === "chat" ? chatModels : [{ id: "nomic-embed-text", name: "nomic-embed-text" }]),
  ai_check: ({ task }) => {
    if (params.has("bad-key")) throw Error("The provider rejected the API key. Check it and try again.");
    return { message: task === "chat" ? "Chat model ready · OK" : "Embedding model ready · 768 dimensions" };
  },
  pipeline_save_source: ({ source }) => {
    s.sources.sources += 1;
    return `source-${source.kind}`;
  },
  pipeline_remove_source: () => {
    s.sources.sources = Math.max(0, s.sources.sources - 1);
  },
  pipeline_check: () => undefined,
  add_document_root: () => {
    s.sources.documentFolders += 1;
  },
  import_legacy: () => {
    s.library = { ...s.library, started: true, imported: true, media: 1284, notes: 312 };
    return { libraryStarted: true, media: 1284, speakers: 46, notes: 312, docs: 20, dataRoot: s.library.dataRoot, legacyDatabase: "" };
  },
};
