// Single source of truth for which transcription engines exist, which
// platforms they run on, and which engine family each model belongs to.
// Used by the dropdown filters so users can't pick a model that will
// fail at spawn time (wrong platform, or the wizard didn't install
// that engine's runtime).

export type TranscriptionEngine = "nemo" | "parakeet" | "whisper" | "fluid";

export interface TranscriptionOption {
  value: string;
  label: string;
  platforms: NodeJS.Platform[] | null;
  engine: TranscriptionEngine;
}

export const TRANSCRIPTION_OPTIONS: TranscriptionOption[] = [
  { value: "nvidia/nemotron-3.5-asr-streaming-0.6b", label: "Nemotron 3.5 (multilingual · native)", platforms: ["linux"], engine: "nemo" },
  { value: "fluid-parakeet-tdt-v3",        label: "Parakeet v3 (Apple Neural Engine, fastest on Mac)", platforms: ["darwin"], engine: "fluid" },
  { value: "nvidia/parakeet-tdt-0.6b-v3",  label: "parakeet-v3 (multilingual, fastest on CUDA)",       platforms: ["linux"],  engine: "parakeet" },
  { value: "large-v3",                     label: "whisper large-v3 (multilingual)",                   platforms: ["linux"],  engine: "whisper" },
  { value: "large-v3-turbo",               label: "whisper turbo",                                     platforms: ["linux"],  engine: "whisper" },
  { value: "medium",                       label: "whisper medium",                                    platforms: ["linux"],  engine: "whisper" },
  { value: "small",                        label: "whisper small",                                     platforms: ["linux"],  engine: "whisper" },
  { value: "tiny",                         label: "whisper tiny",                                      platforms: ["linux"],  engine: "whisper" },
];

/** Wizard-installed engine. The Settings/Library/Pipeline dropdowns
 *  filter to only show models compatible with what's actually installed
 *  on this machine — picking a whisper model after the wizard installed
 *  parakeet just produces a "venv missing" error at retranscribe time. */
export function visibleModels(
  platform: NodeJS.Platform | null,
  currentValue: string | undefined,
  installedEngine?: TranscriptionEngine | "" | null,
): TranscriptionOption[] {
  return TRANSCRIPTION_OPTIONS.filter((o) => {
    if (o.value === currentValue) return true;
    if (platform && o.platforms && !o.platforms.includes(platform)) return false;
    if (installedEngine && o.engine !== installedEngine) return false;
    return true;
  });
}

/** Reuse a model preference only while it matches the configured engine. */
export function compatibleModelSelection(current: string, configured: string): string {
  return current && engineForModel(current) === engineForModel(configured) ? current : configured;
}

/** Lookup an option's engine family by model value. */
export function engineForModel(value: string | undefined | null): TranscriptionEngine | null {
  if (!value) return null;
  return TRANSCRIPTION_OPTIONS.find(o => o.value === value)?.engine ?? null;
}
