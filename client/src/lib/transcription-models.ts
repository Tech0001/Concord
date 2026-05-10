// Single source of truth for which transcription engines exist and which
// platforms they actually run on. Used by the Pipeline page dropdown and
// the per-row model picker in Library so users can't pick a model that
// will fail at spawn time (e.g. Linux Parakeet on Mac → ENOENT).
//
// `platforms: null` means available everywhere.

export interface TranscriptionOption {
  value: string;
  label: string;
  platforms: NodeJS.Platform[] | null;
}

export const TRANSCRIPTION_OPTIONS: TranscriptionOption[] = [
  { value: "fluid-parakeet-tdt-v3",        label: "Parakeet v3 (Apple Neural Engine, fastest on Mac)", platforms: ["darwin"] },
  { value: "nvidia/parakeet-tdt-0.6b-v3",  label: "parakeet-v3 (multilingual, fastest on CUDA)",       platforms: ["linux"] },
  { value: "large-v3",                     label: "whisper large-v3 (multilingual)",                   platforms: ["linux"] },
  { value: "large-v3-turbo",               label: "whisper turbo",                                     platforms: ["linux"] },
  { value: "medium",                       label: "whisper medium",                                    platforms: ["linux"] },
  { value: "small",                        label: "whisper small",                                     platforms: ["linux"] },
  { value: "tiny",                         label: "whisper tiny",                                      platforms: ["linux"] },
];

/** Hide engines that can't run here, but always keep `currentValue` visible
 *  so users can see what's set (instead of the trigger appearing blank). */
export function visibleModels(
  platform: NodeJS.Platform | null,
  currentValue: string | undefined,
): TranscriptionOption[] {
  return TRANSCRIPTION_OPTIONS.filter((o) => {
    if (o.value === currentValue) return true;
    if (!platform || !o.platforms) return true;
    return o.platforms.includes(platform);
  });
}

/** Pick the sensible per-platform default when nothing is saved. */
export function defaultModelForPlatform(platform: NodeJS.Platform | null): string {
  if (platform === "darwin") return "fluid-parakeet-tdt-v3";
  return "large-v3";
}
