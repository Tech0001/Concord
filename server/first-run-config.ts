/** Repair defaults saved by older versions, only in an unfinished, empty archive.
 * Real libraries and existing folders (including a mounted external disk) stay intact.
 */
export function firstRunConfigRepairs(
  stored: Record<string, string>,
  hasMedia: boolean,
  exists: (value: string) => boolean,
  hasRuntime: boolean,
): Record<string, string> {
  if (stored["pipeline.setupCompleted"] === "true" || hasMedia) return {};
  const repairs: Record<string, string> = {};
  for (const [key, suffix] of [["videoSaveDir", "saved_videos"], ["transcriptDir", "transcripts"]]) {
    const value = stored[key];
    if (value && ["/media/pc/Maac/YouTube", "/run/media/pc/Maac/YouTube"].some(root => value === `${root}/${suffix}`)
      && !exists(value)) repairs[key] = "";
  }
  // Older first launches persisted CUDA/Parakeet even before an engine was
  // chosen. Recompute those defaults for this machine if setup never installed one.
  if (!stored["transcription.engine"] && !hasRuntime) {
    for (const key of ["model", "device", "computeType"]) repairs[`transcription.${key}`] = "";
    repairs["processing.diarizationEnabled"] = "";
  }
  return repairs;
}
