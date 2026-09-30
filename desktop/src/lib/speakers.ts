export const SPEAKER_COLORS = [
  "#e0a24b",
  "#6fb3d2",
  "#9ccf8a",
  "#d68ab4",
  "#a79bdc",
  "#e57f6a",
  "#5fc4b8",
  "#c9b458",
  "#8fa3c8",
  "#d99a6c",
] as const;

function hashIndex(key: string, size: number): number {
  let h = 2166136261;
  for (const ch of key) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % size;
}

export function speakerColor(color: string | null | undefined, key: string): string {
  return color && /^#[0-9a-f]{3,8}$/i.test(color) ? color : SPEAKER_COLORS[hashIndex(key, SPEAKER_COLORS.length)];
}

export function voiceLabel(local: string): string {
  const match = /^S(\d+)$/.exec(local);
  return match ? `Speaker ${Number(match[1]) + 1}` : local || "Unknown speaker";
}
