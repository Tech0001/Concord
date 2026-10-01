export type SetupStep = "library" | "speech" | "recordings" | "ai" | "look" | "ready";
export type SetupProgress = {
  step: SetupStep;
  furthest: SetupStep;
  completed: boolean;
  skipped: SetupStep[];
  checklistHidden: boolean;
};
export type SpeechInstall = { status: string; message: string; phase: string; done: number; total: number };
export type ModelDownload = { status: string; message: string; done: number; total: number };
export type LegacyLibrary = {
  path: string;
  folder: string;
  recordings: number;
  speakers: number;
  notes: number;
  speechModelsReusable: boolean;
  reusableBytes: number;
};
export type SetupStatus = {
  progress: SetupProgress;
  library: { started: boolean; imported: boolean; media: number; docs: number; notes: number; dataRoot: string };
  legacy: LegacyLibrary | null;
  speech: { installed: boolean; managed: boolean; device: string; setup: SpeechInstall };
  sources: { sources: number; documentFolders: number };
  search: { kind: string; enabled: boolean; modelReady: boolean; download: ModelDownload };
  chat: { kind: string; enabled: boolean; model: string; connected: boolean };
};
export type Preflight = {
  freeBytes: number | null;
  freeError: string | null;
  neededBytes: number;
  downloadBytes: number;
  modelBytes: number;
  models: { name: string; bytes: number; state: "installed" | "reusable" | "download" }[];
  runtimeBytes: number;
  ffmpeg: boolean;
  network: { ok: boolean; error: string | null };
};
export type LocalServer = { kind: "ollama" | "lmstudio"; baseUrl: string; models: number };
export type SearchChoice = "builtin" | "local" | "openrouter" | "custom" | "off";
export type ChatChoice = "off" | "chatgpt" | "openrouter" | "local" | "custom";
