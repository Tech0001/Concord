import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

export const NEMO_MODEL = "nvidia/nemotron-3.5-asr-streaming-0.6b";
export const NEMO_REVISION = "4c101bc7113f49101a3e11d2c994c519f41939f6";
export const NEMO_ARTIFACTS = [
  { repo: NEMO_MODEL, revision: "1c8deaecc64b91f034d73e08dd8b64625eb3395d",
    file: "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf", size: 741548352,
    sha256: "a5c435f294eea8f88ce68dd27b8c3bfea7f777cb2fbba04fcd30eaa555f429ae" },
  { repo: "nvidia/Nemotron-3-Diarization", revision: "f667ed73aee57d40cc39428eb768b4fd87a0a29e",
    file: "Nemotron-3-Diarization.q8_0.gguf", size: 107012128,
    sha256: "08456d9e22cd9a323c0364d98375f3746d6e68507ebb705cd46438c534c7a3a1" },
] as const;

export function nemoModelDir(): string {
  if (process.env.CONCORD_NEMO_MODELS) return path.resolve(process.env.CONCORD_NEMO_MODELS);
  const home = os.homedir();
  const root = process.platform === "darwin" ? path.join(home, "Library/Application Support/Concord")
    : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(home, "AppData/Roaming"), "Concord")
    : path.join(process.env.XDG_DATA_HOME || path.join(home, ".local/share"), "concord");
  return path.join(root, "models/nemo");
}

export function nemoBinary(): string {
  if (process.env.CONCORD_NEMO_BIN) return path.resolve(process.env.CONCORD_NEMO_BIN);
  const name = process.platform === "win32" ? "nemo-speech.exe" : "nemo-speech";
  const bundled = typeof process.resourcesPath === "string" ? path.join(process.resourcesPath, "binaries/nemo", name) : "";
  return bundled && fs.existsSync(bundled) ? bundled : path.resolve("build/binaries/nemo", name);
}

interface Doctor { features?: { asr?: boolean; diarization?: boolean }; devices?: { name: string; description: string; type: string }[] }
let doctorCache: { binary: string; at: number; value: Doctor | null } | undefined;
export function nemoStatus() {
  const binary = nemoBinary();
  if (!doctorCache || doctorCache.binary !== binary || Date.now() - doctorCache.at > 30_000) {
    const p = spawnSync(binary, ["doctor", "--json"], { encoding: "utf8", timeout: 10_000 });
    let value: Doctor | null = null;
    try { if (p.status === 0) value = JSON.parse(p.stdout); } catch { /* report unavailable */ }
    doctorCache = { binary, at: Date.now(), value };
  }
  const doctor = doctorCache.value;
  const gpu = doctor?.devices?.find(d => d.type === "gpu");
  const device = gpu?.name.startsWith("Vulkan") ? "vulkan:0" : gpu?.name.startsWith("Metal") ? "metal" : "cpu";
  const models = NEMO_ARTIFACTS.map(a => {
    const file = path.join(nemoModelDir(), a.file);
    try { return { ...a, path: file, ready: fs.statSync(file).size === a.size }; }
    catch { return { ...a, path: file, ready: false }; }
  });
  return { binary, available: Boolean(doctor?.features?.asr && doctor.features.diarization),
    device, gpuName: gpu?.description, models, installed: models.every(m => m.ready) && Boolean(doctor?.features?.asr && doctor.features.diarization) };
}

export async function verifyNemoArtifact(file: string, artifact: typeof NEMO_ARTIFACTS[number]): Promise<boolean> {
  try {
    if (fs.statSync(file).size !== artifact.size) return false;
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === artifact.sha256;
  } catch { return false; }
}

/** Pinned downloads, verified before publication; never overwrite a good model on failure. */
export async function installNemoModels(progress: (line: string) => void): Promise<void> {
  if (!nemoStatus().available) throw new Error("NeMo-Speech.cpp is missing or incompatible. Install the Concord NeMo build.");
  fs.mkdirSync(nemoModelDir(), { recursive: true });
  for (const a of NEMO_ARTIFACTS) {
    const dest = path.join(nemoModelDir(), a.file);
    progress(`Checking ${a.file}…`);
    if (await verifyNemoArtifact(dest, a)) { progress("Verified installed model."); continue; }
    const temp = `${dest}.${randomUUID()}.partial`;
    try {
      const response = await fetch(`https://huggingface.co/${a.repo}/resolve/${a.revision}/${a.file}`, { signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
      const out = await fs.promises.open(temp, "wx");
      const reader = response.body.getReader();
      let bytes = 0, lastReport = -1;
      try {
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          let offset = 0;
          while (offset < chunk.length) offset += (await out.write(chunk, offset)).bytesWritten;
          bytes += chunk.length;
          if (bytes > a.size) throw new Error("Model download exceeds its pinned size");
          const percent = Math.floor(100 * bytes / a.size / 5) * 5;
          if (percent !== lastReport) { progress(`${a.file}: ${percent}%`); lastReport = percent; }
        }
      } finally { await reader.cancel().catch(() => {}); await out.close(); }
      if (!await verifyNemoArtifact(temp, a)) throw new Error(`Checksum verification failed for ${a.file}`);
      fs.renameSync(temp, dest);
      progress(`Verified ${a.file}`);
    } finally { fs.rmSync(temp, { force: true }); }
  }
}
