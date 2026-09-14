// Voice-notes session manager.
//
// The browser captures audio from the mic, downsamples it to 16 kHz mono
// int16 PCM in an AudioWorklet, and posts chunks to /api/voice-notes/:id/
// chunk. Each chunk is appended to a growing WAV file on disk (crash-safe
// — the audio is durable before any transcription runs) and then handed
// to FluidAudio offline for a quick "live preview" transcript. On finalize
// the WAV header is fixed up, the file is enqueued into the synthetic
// "Voice notes" channel, and the existing pipeline runs one clean offline
// pass over the whole audio (replacing the seamy chunk-by-chunk preview).
//
// Why offline-per-chunk instead of true streaming: see docs/electron-titlebar.md
// reasoning. FluidAudio is ~80x realtime on Apple Silicon, so a 10s chunk
// transcribes in ~0.1s. The seams between chunks are ugly but only matter
// to the live UI; the final transcript comes from a single full-audio pass.

import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { upsertChannel, getChannelById } from "./db-channels";
import { enqueueVideo, updateQueueStatus } from "./db-queue";
import { getConfigValues } from "./db";
import { ffmpegBin } from "./audio";
import { channelFolderName, datedBaseName } from "./naming";
import { transcribeWithFluidAudio } from "./transcribe-fluidaudio";
import { trackChildProcess } from "./child-process-registry";

// ---- Voice-notes channel ---------------------------------------------------

export const VOICE_NOTES_CHANNEL_ID = "voice-notes";

/** Idempotently create the synthetic "Voice notes" channel row.
 *  Real channel (vs. virtual) so it shows up in channel filter dropdowns
 *  in Library / Search / Map. enabled=false keeps it out of the auto-scan
 *  loop — recordings only land here on explicit user action. */
export function ensureVoiceNotesChannel(): void {
  if (getChannelById(VOICE_NOTES_CHANNEL_ID)) return;
  upsertChannel({
    id: VOICE_NOTES_CHANNEL_ID,
    name: "Voice notes",
    url: "",
    enabled: false,
    diarize: true,
    include_shorts: false,
  });
  console.log(`[voice-notes] created synthetic channel "${VOICE_NOTES_CHANNEL_ID}"`);
}

// ---- Filesystem layout ------------------------------------------------------

/** Root for recorded audio. Lives under the per-user data dir so packaged
 *  app launches without write permission to /Applications work. */
function voiceNotesDir(): string {
  const home = os.homedir();
  const base = process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Concord")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Concord")
      : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local", "share"), "concord");
  return path.join(base, "voice-notes");
}

function sessionWavPath(sessionId: string): string {
  return path.join(voiceNotesDir(), `${sessionId}.wav`);
}

// ---- WAV file plumbing ------------------------------------------------------

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const HEADER_BYTES = 44;

/** Build a 44-byte RIFF/WAVE PCM header. The two size fields (overall RIFF
 *  size and the data chunk size) are written with placeholder zeros and
 *  patched in finalizeSession() once we know the total byte count. */
function buildWavHeader(dataBytes: number): Buffer {
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);             // fmt chunk size
  header.writeUInt16LE(1, 20);              // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// ---- Session state ----------------------------------------------------------

interface VoiceNoteSession {
  id: string;
  wavPath: string;
  startedAt: number;
  /** Total PCM bytes appended so far (NOT counting the 44-byte header).
   *  Tracks duration via `bytes / (sampleRate * channels * 2)`. */
  pcmBytes: number;
  /** Accumulated live-preview transcript chunks, joined for the UI. */
  liveTranscript: string;
  finalized: boolean;
}

const sessions = new Map<string, VoiceNoteSession>();

export function startSession(): VoiceNoteSession {
  ensureVoiceNotesChannel();
  fs.mkdirSync(voiceNotesDir(), { recursive: true });
  const id = `vn-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
  const wavPath = sessionWavPath(id);
  // Pre-write the header with zero data size so the file is a valid (empty)
  // WAV from the moment it exists. If we crash mid-recording the user gets
  // an audible WAV with whatever was captured up to the last chunk flush.
  fs.writeFileSync(wavPath, buildWavHeader(0));
  const session: VoiceNoteSession = {
    id,
    wavPath,
    startedAt: Date.now(),
    pcmBytes: 0,
    liveTranscript: "",
    finalized: false,
  };
  sessions.set(id, session);
  console.log(`[voice-notes] session ${id} started → ${wavPath}`);
  return session;
}

export function getSession(id: string): VoiceNoteSession | undefined {
  return sessions.get(id);
}

/** Append a chunk of raw 16 kHz mono int16 LE PCM to the session WAV.
 *  The header's data-size field stays stale until finalizeSession patches
 *  it; that's fine for a crash recovery — players that read up to the
 *  declared size will get a slightly short clip, but the bytes after are
 *  valid PCM and can be recovered with ffmpeg if needed. */
export function appendChunk(sessionId: string, pcm: Buffer): VoiceNoteSession {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`unknown voice-note session: ${sessionId}`);
  if (session.finalized) throw new Error(`session ${sessionId} already finalized`);
  fs.appendFileSync(session.wavPath, pcm);
  session.pcmBytes += pcm.length;
  return session;
}

// ---- Chunk transcription ---------------------------------------------------

/** Spawn FluidAudio on a one-off WAV that contains just one chunk's worth
 *  of PCM. Strictly for the live preview — the final authoritative
 *  transcript comes from the full-audio offline pass after finalize.
 *  Returns the empty string on any failure (preview is best-effort). */
export async function transcribeChunk(pcm: Buffer): Promise<string> {
  // Write the chunk to a self-contained WAV in the OS temp dir, transcribe,
  // delete. We can't use FluidAudio's streaming API from the bundled CLI;
  // see docs/electron-titlebar.md for the design discussion.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "concord-voice-"));
  const wavPath = path.join(tmpDir, "chunk.wav");
  const mdPath = path.join(tmpDir, "chunk.md");
  const jsonPath = path.join(tmpDir, "chunk.json");
  try {
    fs.writeFileSync(wavPath, Buffer.concat([buildWavHeader(pcm.length), pcm]));
    await transcribeWithFluidAudio(wavPath, mdPath, {
      model: "fluid-parakeet-tdt-v3",
      diarize: false, // skip diarization for chunks — saves 2-5x time, the offline pass will diarize properly
    });
    if (!fs.existsSync(jsonPath)) return "";
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as { text?: string };
    return (raw.text || "").trim();
  } catch (err) {
    console.warn(`[voice-notes] chunk transcribe failed (preview only):`, err);
    return "";
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Append the new chunk's transcript onto the session's running preview
 *  with a space separator. The seams between chunks won't be perfect —
 *  finalize re-transcribes the full audio for a clean version. */
export function appendLiveTranscript(sessionId: string, text: string): string {
  const session = sessions.get(sessionId);
  if (!session) return "";
  if (text) {
    session.liveTranscript = session.liveTranscript
      ? `${session.liveTranscript} ${text}`
      : text;
  }
  return session.liveTranscript;
}

// ---- Finalize --------------------------------------------------------------

export interface FinalizeResult {
  videoId: string;
  channelId: string;
  audioPath: string;
  durationSeconds: number;
}

/** Encode a finished WAV to m4a/AAC using the bundled ffmpeg. ~10× smaller
 *  than the WAV at near-indistinguishable quality for voice. faststart so
 *  the file is seekable mid-playback without downloading the whole thing
 *  (relevant when streaming via /api/videos/library/.../stream). */
function encodeWavToM4a(wavPath: string, m4aPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-i", wavPath,
      "-c:a", "aac",
      "-b:a", "96k",
      "-movflags", "+faststart",
      "-y",
      m4aPath,
    ];
    const proc = trackChildProcess(
      spawn(ffmpegBin, args, { stdio: ["ignore", "pipe", "pipe"] }),
      "ffmpeg voice note",
    );
    let stderr = "";
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Patch the WAV header, encode to m4a in the user's videoSaveDir under
 *  the Voice notes channel folder, drop the temp WAV, and enqueue. The
 *  pipeline picks the row up immediately (via pipeline.kickQueue() from
 *  the route handler) and runs the authoritative full-audio FluidAudio
 *  pass over the m4a, producing the stored transcript md and embeddings. */
export async function finalizeSession(sessionId: string, opts: { title?: string } = {}): Promise<FinalizeResult> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`unknown voice-note session: ${sessionId}`);
  if (session.finalized) throw new Error(`session ${sessionId} already finalized`);

  // Patch header: bytes 4..7 = 36 + dataBytes, bytes 40..43 = dataBytes.
  const fd = fs.openSync(session.wavPath, "r+");
  try {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(36 + session.pcmBytes, 0);
    fs.writeSync(fd, buf, 0, 4, 4);
    buf.writeUInt32LE(session.pcmBytes, 0);
    fs.writeSync(fd, buf, 0, 4, 40);
  } finally {
    fs.closeSync(fd);
  }

  const durationSeconds = session.pcmBytes / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));
  ensureVoiceNotesChannel();

  const videoId = session.id;
  const now = new Date();
  const uploadDate = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, "0")
    + String(now.getDate()).padStart(2, "0");
  const defaultTitle = `Voice note ${now.toISOString().slice(0, 19).replace("T", " ")}`;
  const title = (opts.title || defaultTitle).trim() || defaultTitle;

  // Resolve target location under the user-configured videoSaveDir. Fall
  // back to the temp WAV path when videoSaveDir is unset so we don't
  // silently lose the recording — user fixes the path and the file is
  // still where they left it. The pipeline still works pointing at the
  // wav since FluidAudio handles wav input fine.
  const cfg = getConfigValues();
  const videoSaveDir = (cfg.videoSaveDir || "").trim();
  const channelFolder = channelFolderName("Voice notes");
  const safeName = datedBaseName(title, uploadDate);

  let finalAudioPath = session.wavPath;
  if (videoSaveDir) {
    try {
      const destDir = path.join(videoSaveDir, channelFolder);
      fs.mkdirSync(destDir, { recursive: true });
      const m4aPath = path.join(destDir, `${safeName}.m4a`);
      await encodeWavToM4a(session.wavPath, m4aPath);
      try { fs.unlinkSync(session.wavPath); } catch { /* ignore */ }
      finalAudioPath = m4aPath;
    } catch (err) {
      console.warn(`[voice-notes] m4a encode failed, keeping wav: ${err instanceof Error ? err.message : err}`);
      // Fall through with finalAudioPath still pointing at the WAV.
    }
  } else {
    console.warn(`[voice-notes] videoSaveDir not configured — keeping recording at ${session.wavPath}`);
  }

  const audioFileUrl = `file://${finalAudioPath}`;
  const inserted = enqueueVideo({
    videoId,
    channelId: VOICE_NOTES_CHANNEL_ID,
    title,
    url: audioFileUrl,
    duration: Math.round(durationSeconds),
    isLive: false,
    isShorts: false,
    uploadDate,
  });

  // Attach the on-disk path so processVideo's linked-existing branch
  // picks it up without re-downloading or re-recording.
  updateQueueStatus(videoId, VOICE_NOTES_CHANNEL_ID, {
    videoPath: finalAudioPath,
    status: "pending",
    error: null,
  });

  session.finalized = true;
  sessions.delete(sessionId);

  console.log(
    `[voice-notes] finalized ${sessionId} (${durationSeconds.toFixed(1)}s)`
    + ` → ${finalAudioPath}${inserted ? "" : " (existing queue row reused)"}`,
  );

  return {
    videoId,
    channelId: VOICE_NOTES_CHANNEL_ID,
    audioPath: finalAudioPath,
    durationSeconds,
  };
}

/** Drop a session without enqueueing — used when the user hits cancel
 *  before saving. The WAV file is deleted from disk too. */
export function cancelSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  try { fs.unlinkSync(session.wavPath); } catch { /* ignore */ }
  sessions.delete(sessionId);
  console.log(`[voice-notes] cancelled session ${sessionId}`);
}

// Suppress the "spawn imported but unused" warning — left available for future
// streaming variants without re-importing.
void spawn;
