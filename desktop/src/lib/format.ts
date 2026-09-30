const pad = (n: number) => String(n).padStart(2, "0");
const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export function clock(seconds: number): string {
  const v = Math.max(0, Math.floor(finite(seconds)));
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  const s = v % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function clockPrecise(seconds: number): string {
  const v = Math.max(0, finite(seconds));
  return `${clock(v)}.${Math.floor((v % 1) * 10)}`;
}

export function humanDuration(seconds: number): string {
  const v = Math.max(0, Math.round(finite(seconds)));
  if (v < 60) return `${v}s`;
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function prettyDate(s: string): string {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s || "Undated";
}

export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

function compact(seconds: number): string {
  const v = Math.max(0, Math.floor(finite(seconds)));
  const h = Math.floor(v / 3600);
  const m = Math.floor(v / 60) % 60;
  const s = v % 60;
  return h ? `${h}h${pad(m)}m${pad(s)}s` : `${m}m${pad(s)}s`;
}

export function rangeLabel(start: number, end: number): string {
  return `${compact(start)}–${compact(end)}`;
}

export function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[/\\:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  return Array.from(cleaned || "Recording")
    .slice(0, 120)
    .join("")
    .trim();
}

export function exportName(title: string, start: number, end: number, ext: string): string {
  return `${safeFileName(title)} — ${rangeLabel(start, end)}.${ext}`;
}

export function parseClock(input: string): number | null {
  const text = input.trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const parts = whole.split(":").map(Number);
  if (parts.slice(1).some((p) => p > 59)) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds + (fraction ? Number(`0.${fraction}`) : 0);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function extension(path: string | null | undefined): string {
  const match = /\.([a-z0-9]+)$/i.exec(path ?? "");
  return match ? match[1].toLowerCase() : "";
}
