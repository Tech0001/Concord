import type { ChatChoice, SearchChoice, SetupStatus, SetupStep, SpeechInstall } from "./types.ts";

export const STEPS: SetupStep[] = ["library", "speech", "recordings", "ai", "look", "ready"];
/** The five steps shown in the rail; Ready is the summary after them. */
export const NUMBERED = STEPS.slice(0, 5);
export const STEP_LABEL: Record<SetupStep, string> = {
  library: "Library",
  speech: "Speech engine",
  recordings: "Recordings",
  ai: "Search & AI",
  look: "Look & feel",
  ready: "Ready",
};

export const isStep = (v: unknown): v is SetupStep => typeof v === "string" && (STEPS as string[]).includes(v);
const index = (step: SetupStep) => STEPS.indexOf(step);
export const nextStep = (step: SetupStep): SetupStep => STEPS[Math.min(index(step) + 1, STEPS.length - 1)];
export const previousStep = (step: SetupStep): SetupStep | null => (index(step) > 0 ? STEPS[index(step) - 1] : null);

/** Percent of the model download, or null while installing voice matching or when idle. */
export function speechPercent(setup: SpeechInstall): number | null {
  if (setup.status !== "running" || setup.phase !== "models" || setup.total <= 0) return null;
  return Math.min(99, Math.floor((setup.done / setup.total) * 100));
}

type Speech = "installed" | "running" | "paused" | "failed" | "missing";
/** Paused covers both Pause and Concord closing mid-install; both resume where they stopped. */
export function speechState(s: SetupStatus): Speech {
  const status = s.speech.setup.status;
  if (status === "running") return "running";
  if (s.speech.installed) return "installed";
  if (status === "failed") return "failed";
  if (status === "interrupted" || status === "cancelled") return "paused";
  return "missing";
}
const searchDownloading = (s: SetupStatus) => ["waiting", "running"].includes(s.search.download.status);
const hasRecordings = (s: SetupStatus) => s.sources.sources > 0 || s.sources.documentFolders > 0 || s.library.media > 0;
const reached = (s: SetupStatus, step: SetupStep) => s.progress.completed || index(s.progress.furthest) > index(step);

export type StepState = "current" | "done" | "running" | "failed" | "skipped" | "todo";
export function stepState(s: SetupStatus, step: SetupStep, current: SetupStep): StepState {
  if (step === current) return "current";
  const skipped = s.progress.skipped.includes(step);
  switch (step) {
    case "library":
      return s.library.started ? "done" : "todo";
    case "speech": {
      const speech = speechState(s);
      if (speech === "running") return "running";
      if (speech === "installed") return "done";
      if (speech === "failed") return "failed";
      return skipped && speech === "missing" ? "skipped" : "todo";
    }
    case "recordings":
      if (hasRecordings(s)) return "done";
      return skipped ? "skipped" : reached(s, step) ? "done" : "todo";
    default:
      return skipped ? "skipped" : reached(s, step) ? "done" : "todo";
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const SEARCH_NAME: Record<string, string> = { builtin: "Local", local: "Local server", openrouter: "OpenRouter", custom: "Custom" };
export const CHAT_NAME: Record<string, string> = { chatgpt: "ChatGPT", openrouter: "OpenRouter", local: "Local", custom: "Custom" };

export function speechSummary(s: SetupStatus): string {
  const speech = speechState(s);
  if (speech === "installed") return s.speech.managed ? "Installed" : "Shared with the previous app";
  if (speech === "running") {
    const pct = speechPercent(s.speech.setup);
    return pct == null ? "Setting up voice matching" : `Installing · ${pct}%`;
  }
  if (speech === "paused") return "Paused · resume to finish";
  if (speech === "failed") return "Needs attention";
  return s.progress.skipped.includes("speech") ? "Skipped" : "Recommended";
}

export function recordingsSummary(s: SetupStatus): string {
  const parts = [];
  if (s.sources.sources) parts.push(plural(s.sources.sources, "source"));
  if (s.sources.documentFolders) parts.push(plural(s.sources.documentFolders, "document folder"));
  if (!parts.length && s.library.media) parts.push(plural(s.library.media, "recording"));
  return parts.join(" · ");
}

export function aiSummary(s: SetupStatus): string {
  const search = s.search.enabled ? `${SEARCH_NAME[s.search.kind] ?? "Custom"} search` : "Exact-word search";
  return s.chat.connected ? `${search} · ${CHAT_NAME[s.chat.kind] ?? "Custom"} chat` : search;
}

/** A few words under each step in the rail. `look` describes the current appearance. */
export function stepSummary(s: SetupStatus, step: SetupStep, look = ""): string {
  const skipped = s.progress.skipped.includes(step);
  switch (step) {
    case "library":
      return s.library.imported ? "Imported library" : s.library.started ? "New library" : "Start or import";
    case "speech":
      return speechSummary(s);
    case "recordings":
      return recordingsSummary(s) || (skipped ? "Skipped" : reached(s, step) ? "Nothing added" : "Optional");
    case "ai":
      return skipped ? "Skipped" : reached(s, step) || s.chat.connected ? aiSummary(s) : "Optional";
    case "look":
      return reached(s, step) && look ? look : "Optional";
    default:
      return "";
  }
}

export type ChecklistItem = {
  id: "library" | "speech" | "recordings" | "search" | "chat";
  title: string;
  detail: string;
  state: "done" | "running" | "failed" | "todo";
};
export function checklist(s: SetupStatus): ChecklistItem[] {
  const speech = speechState(s);
  return [
    {
      id: "library",
      title: "Start your library",
      detail: s.library.imported ? "Imported library" : s.library.started ? "New library" : "Start new or import",
      state: s.library.started ? "done" : "todo",
    },
    {
      id: "speech",
      title: "Install the speech engine",
      detail:
        speech === "missing"
          ? "Transcription on this computer · about 950 MB plus a 2.2 GB runtime"
          : speech === "paused" && s.speech.setup.phase === "models" && s.speech.setup.done > 0
            ? `Paused at ${Math.round(s.speech.setup.done / 1e6)} of ${formatBytes(s.speech.setup.total)} · resume any time`
            : speech === "paused"
              ? "Paused · resume any time"
              : speechSummary(s),
      state: speech === "installed" ? "done" : speech === "paused" || speech === "missing" ? "todo" : speech,
    },
    {
      id: "recordings",
      title: "Add recordings",
      detail: recordingsSummary(s) || "Files, a folder, YouTube, or documents",
      state: hasRecordings(s) ? "done" : "todo",
    },
    {
      id: "search",
      title: "Turn on Smart search",
      detail: s.search.modelReady
        ? `${SEARCH_NAME[s.search.kind] ?? "Custom"} search is ready`
        : searchDownloading(s)
          ? s.search.download.status === "waiting"
            ? "Downloads after the speech engine"
            : `Downloading · ${Math.floor((s.search.download.done / Math.max(1, s.search.download.total)) * 100)}%`
          : "Search by meaning · 639 MB, on this computer",
      state: s.search.modelReady ? "done" : searchDownloading(s) ? "running" : "todo",
    },
    {
      id: "chat",
      title: "Ask your archive",
      detail: s.chat.connected ? `${CHAT_NAME[s.chat.kind] ?? "Custom"} · connected` : "Chat with answers quoted from your recordings",
      state: s.chat.connected ? "done" : "todo",
    },
  ];
}

const SEARCH_PRIVACY: Record<SearchChoice, string> = {
  builtin: "Search runs on this computer.",
  local: "Search uses your local server and stays on this computer.",
  openrouter: "Search sends transcript text to OpenRouter to build its index.",
  custom: "Search sends transcript text to the address you entered to build its index.",
  off: "Search matches exact words only, on this computer.",
};
const CHAT_PRIVACY: Record<ChatChoice, string> = {
  off: "No chat provider is connected.",
  chatgpt: "Chat sends your question and the matching passages to OpenAI.",
  openrouter: "Chat sends your question and the matching passages to OpenRouter.",
  local: "Chat uses your local server and stays on this computer.",
  custom: "Chat sends your question and the matching passages to the address you enter.",
};
export const privacyLines = (search: SearchChoice, chat: ChatChoice) => [SEARCH_PRIVACY[search], CHAT_PRIVACY[chat]];

export function formatBytes(n: number): string {
  if (n >= 1e9) {
    const gb = n / 1e9;
    return `${gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
  }
  return `${Math.round(n / 1e6)} MB`;
}
