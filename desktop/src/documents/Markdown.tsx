import { createElement, type ReactNode } from "react";

/**
 * Minimal, dependency-free Markdown renderer ported from the Electron app. Handles headings,
 * paragraphs, lists, blockquotes, fenced code, rules, emphasis, inline code, and links.
 * Tables, footnotes, and embedded HTML are intentionally unsupported. Images show their alt
 * text, because stored document text does not carry its image files.
 */
export function Markdown({ source }: { source: string }) {
  const blocks = parseBlocks(stripFrontmatter(stripExcalidrawScene(source)));
  return <div className="md">{blocks.map((block, i) => renderBlock(block, i))}</div>;
}

function stripExcalidrawScene(source: string): string {
  const sceneStart = source.indexOf("==⚠ Switch to EXCALIDRAW VIEW");
  if (sceneStart === -1) return source;
  return source.slice(0, sceneStart).trimEnd() + "\n\n> _Excalidraw scene data hidden — open the file in Excalidraw to view the diagram._\n";
}

/** A leading YAML block (--- … ---) is metadata, not prose. */
function stripFrontmatter(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "blockquote"; text: string }
  | { kind: "code"; lang: string; text: string }
  | { kind: "hr" };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", lang: fence[1] || "", text: body.join("\n") });
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "blockquote", text: buf.join(" ") });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      blocks.push({ kind: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      blocks.push({ kind: "ol", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++]);
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

function isBlockStart(line: string): boolean {
  return (
    /^```/.test(line) ||
    /^#{1,6}\s+/.test(line) ||
    /^\s*>/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*(---|\*\*\*|___)\s*$/.test(line)
  );
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading":
      return createElement(`h${block.level}`, { key, className: `md-h md-h${block.level}` }, renderInline(block.text));
    case "paragraph":
      return <p key={key}>{renderInline(block.text)}</p>;
    case "ul":
      return (
        <ul key={key}>
          {block.items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol key={key}>
          {block.items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>
      );
    case "blockquote":
      return <blockquote key={key}>{renderInline(block.text)}</blockquote>;
    case "code":
      return (
        <pre key={key} className="md-pre">
          <code>{block.text}</code>
        </pre>
      );
    case "hr":
      return <hr key={key} />;
  }
}

/** Single pass over the inline grammar so escapes and nesting behave predictably. */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let key = 0;
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push(
          <code key={`c-${key++}`} className="md-code">
            {text.slice(i + 1, end)}
          </code>,
        );
        i = end + 1;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const end = text.indexOf(ch + ch, i + 2);
      if (end > i) {
        flush();
        out.push(<strong key={`b-${key++}`}>{renderInline(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end > i && /\S/.test(text.slice(i + 1, end))) {
        flush();
        out.push(<em key={`i-${key++}`}>{renderInline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }
    if (ch === "!" && text[i + 1] === "[") {
      const close = text.indexOf("]", i + 2);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close) {
          flush();
          out.push(
            <span key={`img-${key++}`} className="md-image-missing">
              Image{text.slice(i + 2, close) ? `: ${text.slice(i + 2, close)}` : ""}
            </span>,
          );
          i = urlEnd + 1;
          continue;
        }
      }
    }
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close) {
          flush();
          const label = renderInline(text.slice(i + 1, close));
          const href = text.slice(close + 2, urlEnd).trim();
          out.push(
            /^https?:\/\//i.test(href) ? (
              <a key={`l-${key++}`} href={href} target="_blank" rel="noreferrer" className="md-link">
                {label}
              </a>
            ) : (
              <span key={`l-${key++}`}>{label}</span>
            ),
          );
          i = urlEnd + 1;
          continue;
        }
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
