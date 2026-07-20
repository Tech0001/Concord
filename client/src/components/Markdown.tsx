import { createContext, useContext, type ReactNode } from "react";

/**
 * Minimal CommonMark-ish renderer. Handles the markdown features that
 * show up in planning / research docs (headings, paragraphs, lists,
 * code, links, emphasis, blockquotes, horizontal rules, images) without
 * pulling in a markdown library — keeps the dependency surface small
 * per the project's supply-chain caution.
 *
 * Intentionally NOT supported (out of scope for v1):
 *   - Tables (rare in planning docs)
 *   - Footnotes / definition lists
 *   - Embedded HTML
 *   - Syntax highlighting inside code blocks
 *
 * Files saved by the Excalidraw VS Code plugin embed a large base64
 * scene blob between `%%` markers — those don't read as text. We strip
 * that section and surface a small notice in its place instead.
 */

/** How to turn a markdown image `src` into a loadable URL. The viewer
 *  supplies this so a doc-relative path (`./images/x.png`) resolves to
 *  the /api/docs/asset endpoint for the right root; absolute and data:
 *  URLs pass straight through. Defaults to identity (raw src). */
const ResolveImageSrc = createContext<(src: string) => string>((s) => s);

export function Markdown({
  source,
  resolveImageSrc,
}: {
  source: string;
  resolveImageSrc?: (src: string) => string;
}) {
  const blocks = parseBlocks(stripExcalidrawScene(source));
  return (
    <ResolveImageSrc.Provider value={resolveImageSrc ?? ((s) => s)}>
      <div className="markdown-body space-y-3 text-sm leading-6 break-words">
        {blocks.map((block, i) => renderBlock(block, i))}
      </div>
    </ResolveImageSrc.Provider>
  );
}

/** Build a resolver that turns a markdown image `src` into a URL the
 *  browser can load. Doc-relative paths (`./images/x.png`, `../a.png`,
 *  `img/x.png`) resolve against the doc's own directory and point at
 *  the /api/docs/asset endpoint for the doc's root; absolute (http/
 *  data/blob) URLs pass through untouched. */
export function makeDocImageResolver(
  rootId: string | null | undefined,
  docRelPath: string,
): (src: string) => string {
  const baseDir = docRelPath.includes("/")
    ? docRelPath.slice(0, docRelPath.lastIndexOf("/"))
    : "";
  return (src: string) => {
    const raw = src.trim();
    if (!raw || /^(https?:|data:|blob:|#)/i.test(raw)) return raw;
    let rel = raw.replace(/^\/+/, ""); // leading slash → treat as root-relative
    try { rel = decodeURIComponent(rel); } catch { /* keep raw */ }
    const parts = baseDir ? baseDir.split("/") : [];
    for (const seg of rel.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { if (parts.length) parts.pop(); }
      else parts.push(seg);
    }
    const qs = new URLSearchParams({ path: parts.join("/") });
    if (rootId != null) qs.set("rootId", String(rootId));
    return `/api/docs/asset?${qs.toString()}`;
  };
}

/** Image node — a real component so it can read the resolver from
 *  context (renderInline is a plain function and can't call hooks). */
function DocImage({ src, alt }: { src: string; alt: string }) {
  const resolve = useContext(ResolveImageSrc);
  return (
    <img
      src={resolve(src)}
      alt={alt}
      loading="lazy"
      className="my-2 max-w-full rounded border"
    />
  );
}

// ---- Excalidraw stripping ------------------------------------------

function stripExcalidrawScene(source: string): string {
  const sceneStart = source.indexOf("==⚠ Switch to EXCALIDRAW VIEW");
  if (sceneStart === -1) return source;
  // Replace from the marker to the end with a small notice. The
  // text BEFORE the marker (frontmatter + any notes the user wrote
  // above the scene) is preserved.
  return source.slice(0, sceneStart).trimEnd()
    + "\n\n> _Excalidraw scene data hidden — open the file in Excalidraw to view the diagram._\n";
}

// ---- Block parsing -------------------------------------------------

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

    // Skip blank lines between blocks.
    if (!line.trim()) { i++; continue; }

    // Fenced code block: ``` or ```lang
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    // Horizontal rule.
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    // Heading: 1–6 leading '#' followed by a space.
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    // Blockquote: one or more '>' lines.
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "blockquote", text: buf.join(" ") });
      continue;
    }

    // Unordered list: '- ' or '* '.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    // Ordered list: '1. ', '2. ', etc.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragraph: run until blank line or a stronger pattern.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }

  return blocks;
}

function isBlockStart(line: string): boolean {
  return /^```/.test(line)
    || /^#{1,6}\s+/.test(line)
    || /^\s*>/.test(line)
    || /^\s*[-*]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || /^\s*(---|\*\*\*|___)\s*$/.test(line);
}

// ---- Block rendering ----------------------------------------------

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const sizes = ["text-2xl", "text-xl", "text-lg", "text-base", "text-sm", "text-xs"];
      const size = sizes[block.level - 1] ?? "text-sm";
      return (
        <div key={key} className={`${size} font-semibold tracking-tight mt-4`}>
          {renderInline(block.text)}
        </div>
      );
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.text)}</p>;
    case "ul":
      return (
        <ul key={key} className="list-disc pl-5 space-y-0.5">
          {block.items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="list-decimal pl-5 space-y-0.5">
          {block.items.map((it, idx) => <li key={idx}>{renderInline(it)}</li>)}
        </ol>
      );
    case "blockquote":
      return (
        <blockquote key={key} className="border-l-2 border-muted-foreground/40 pl-3 italic text-muted-foreground">
          {renderInline(block.text)}
        </blockquote>
      );
    case "code":
      return (
        <pre key={key} className="rounded border bg-muted/40 p-3 text-xs overflow-x-auto">
          <code>{block.text}</code>
        </pre>
      );
    case "hr":
      return <hr key={key} className="border-border" />;
  }
}

// ---- Inline parsing ------------------------------------------------

/**
 * Walks a string once and emits ReactNodes for the inline grammar
 * (code, bold, italic, links). Hand-rolled rather than regex-replace
 * so escapes and nesting (e.g. `**bold *and* still bold**`) behave
 * predictably.
 */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = "";
  let i = 0;
  let key = 0;
  const flushText = () => {
    if (buf) { out.push(buf); buf = ""; }
  };

  while (i < text.length) {
    const ch = text[i];

    // Inline code — wins over emphasis, can't nest.
    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flushText();
        out.push(<code key={`c-${key++}`} className="rounded bg-muted px-1 py-0.5 text-[12px] font-mono">{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }

    // Bold: ** or __
    if ((ch === "*" || ch === "_") && text[i + 1] === ch) {
      const marker = ch + ch;
      const end = text.indexOf(marker, i + 2);
      if (end > i) {
        flushText();
        out.push(<strong key={`b-${key++}`}>{renderInline(text.slice(i + 2, end))}</strong>);
        i = end + 2;
        continue;
      }
    }

    // Italic: single * or _, but not when followed by the same char
    // (would be the bold marker we already handle above).
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end > i && /\S/.test(text.slice(i + 1, end))) {
        flushText();
        out.push(<em key={`i-${key++}`}>{renderInline(text.slice(i + 1, end))}</em>);
        i = end + 1;
        continue;
      }
    }

    // Image: ![alt](src) or ![alt](src "title"). Must be checked before
    // the link branch since it's a `!` immediately followed by `[...]`.
    if (ch === "!" && text[i + 1] === "[") {
      const close = text.indexOf("]", i + 2);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close) {
          flushText();
          const alt = text.slice(i + 2, close);
          // Strip an optional `"title"` after the URL, keep the URL.
          const src = text.slice(close + 2, urlEnd).trim().split(/\s+/)[0];
          out.push(<DocImage key={`img-${key++}`} src={src} alt={alt} />);
          i = urlEnd + 1;
          continue;
        }
      }
    }

    // Link: [text](url)
    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close) {
          flushText();
          const label = text.slice(i + 1, close);
          const href = text.slice(close + 2, urlEnd);
          out.push(
            <a
              key={`l-${key++}`}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2 hover:no-underline"
            >
              {renderInline(label)}
            </a>,
          );
          i = urlEnd + 1;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flushText();
  return out;
}
