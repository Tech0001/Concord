export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "blockquote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "hr" };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = fenceStart(line);
    if (fence) {
      const body: string[] = [];
      i++;
      const close = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \t]*$`);
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({
        kind: "code",
        lang: fence.info.trim().split(/\s+/)[0] || "",
        text: body.join("\n"),
      });
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        text: heading[2],
      });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]))
        buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "blockquote", text: buf.join(" ") });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push({ kind: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      blocks.push({ kind: "ol", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]))
      para.push(lines[i++]);
    // Always advance even if a future block recognizer declines this line.
    if (!para.length) para.push(lines[i++]);
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    fenceStart(line) !== null ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*(---|\*\*\*|___)\s*$/.test(line)
  );
}

function fenceStart(line: string): { marker: string; length: number; info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return null;
  return { marker: match[1][0], length: match[1].length, info: match[2] };
}
