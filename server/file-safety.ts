import fs from "fs";
import path from "path";

/** True when two path strings resolve to the same filesystem entry. The
 * lexical check catches a not-yet-created output path; realpath/stat also
 * catch symlinks and hard links before any destructive operation runs. */
export function pathsReferToSameFile(first: string, second: string): boolean {
  if (path.resolve(first) === path.resolve(second)) return true;
  try {
    if (fs.realpathSync.native(first) === fs.realpathSync.native(second)) return true;
  } catch { /* one path may not exist yet */ }
  try {
    const a = fs.statSync(first);
    const b = fs.statSync(second);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** Last-line guard for ffmpeg and similar tools invoked with overwrite
 * enabled. An input/output alias could otherwise truncate the source. */
export function assertDistinctOutputPath(inputPath: string, outputPath: string, operation: string): void {
  if (pathsReferToSameFile(inputPath, outputPath)) {
    throw new Error(`${operation} refused because input and output resolve to the same file: ${inputPath}`);
  }
}

/** Delete scratch/derived data only after proving it is not a protected
 * source. Returns false for a protected, missing, or undeletable path. */
export function unlinkDerivedFile(
  candidate: string | null | undefined,
  protectedSources: Array<string | null | undefined>,
  context: string,
): boolean {
  if (!candidate) return false;
  const protectedPath = protectedSources.find(source => source && pathsReferToSameFile(candidate, source));
  if (protectedPath) {
    console.error(`[file-safety] Refused to delete protected source during ${context}: ${candidate}`);
    return false;
  }
  try {
    fs.unlinkSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[file-safety] Could not remove derived file during ${context}: ${candidate} — ${error instanceof Error ? error.message : error}`);
    }
    return false;
  }
}
