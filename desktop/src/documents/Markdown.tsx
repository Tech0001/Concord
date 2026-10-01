import { parseBlocks, type Block } from "./markdown-blocks.ts";
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "../lib/ipc.ts";
import { useToast } from "../ui/Toasts.tsx";
const DocumentContext = createContext<{
  id?: string;
  onDocument?: (id: string) => void;
  appLinks?: Record<string, () => void>;
  citation?: (number: number) => ReactNode;
}>({});

/**
 * Minimal, dependency-free Markdown renderer ported from the Electron app. Handles headings,
 * paragraphs, lists, blockquotes, fenced code, rules, emphasis, inline code, and links.
 * Tables, footnotes, and embedded HTML are currently unsupported. Document images resolve
 * through the host with folder-boundary checks; remote images are never fetched automatically.
 */
export function Markdown({
  source,
  documentId,
  onDocument,
  omitTitle,
  appLinks,
  citation,
}: {
  source: string;
  documentId?: string;
  onDocument?: (id: string) => void;
  appLinks?: Record<string, () => void>;
  citation?: (number: number) => ReactNode;
  omitTitle?: string;
}) {
  const blocks = parseBlocks(stripFrontmatter(stripExcalidrawScene(source)));
  if (
    omitTitle &&
    blocks[0]?.kind === "heading" &&
    blocks[0].text === omitTitle
  )
    blocks.shift();
  return (
    <DocumentContext.Provider value={{ id: documentId, onDocument, appLinks, citation }}>
      <div className="md">
        {blocks.map((block, i) => renderBlock(block, i))}
      </div>
    </DocumentContext.Provider>
  );
}

function stripExcalidrawScene(source: string): string {
  const sceneStart = source.indexOf("==⚠ Switch to EXCALIDRAW VIEW");
  if (sceneStart === -1) return source;
  return (
    source.slice(0, sceneStart).trimEnd() +
    "\n\n> _Excalidraw scene data hidden — open the file in Excalidraw to view the diagram._\n"
  );
}

/** A leading YAML block (--- … ---) is metadata, not prose. */
function stripFrontmatter(source: string): string {
  const match = /^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/.exec(source);
  return match ? source.slice(match[0].length) : source;
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading":
      return createElement(
        `h${block.level}`,
        { key, className: `md-h md-h${block.level}` },
        renderInline(block.text),
      );
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
        out.push(
          <strong key={`b-${key++}`}>
            {renderInline(text.slice(i + 2, end))}
          </strong>,
        );
        i = end + 2;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && text[i + 1] !== ch) {
      const end = text.indexOf(ch, i + 1);
      if (end > i && /\S/.test(text.slice(i + 1, end))) {
        flush();
        out.push(
          <em key={`i-${key++}`}>{renderInline(text.slice(i + 1, end))}</em>,
        );
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
            <DocumentImage
              key={`img-${key++}`}
              href={text.slice(close + 2, urlEnd).trim()}
              alt={text.slice(i + 2, close)}
            />,
          );
          i = urlEnd + 1;
          continue;
        }
      }
    }
    if (ch === "[") {
      const reference = /^\[(\d+)\](?!\()/.exec(text.slice(i));
      if (reference) {flush();out.push(<InlineCitation key={`r-${key++}`} number={Number(reference[1])}/>);i+=reference[0].length;continue;}
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close) {
          flush();
          const label = renderInline(text.slice(i + 1, close));
          const href = text.slice(close + 2, urlEnd).trim();
          out.push(
            <MarkdownLink key={`l-${key++}`} href={href}>
              {label}
            </MarkdownLink>,
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

function DocumentImage({ href, alt }: { href: string; alt: string }) {
  const { id } = useContext(DocumentContext);
  const [src, setSrc] = useState<string>(),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    setSrc(undefined);
    setError("");
    if (id && !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(href)) {
      try {
        void api
          .documentAsset(id, decodeURIComponent(href.split("#")[0]))
          .then((src) => alive && setSrc(src))
          .catch((e) => alive && setError(String(e)));
      } catch (e) {
        setError(String(e));
      }
    }
    return () => {
      alive = false;
    };
  }, [id, href]);
  return src ? (
    <img
      className="md-image"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => {
        setSrc(undefined);
        setError("Image could not be displayed");
      }}
    />
  ) : (
    <span className="md-image-missing" title={error || href}>
      Image{alt ? `: ${alt}` : ""}
    </span>
  );
}
function MarkdownLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  const { id, onDocument, appLinks } = useContext(DocumentContext);
  const toast = useToast();
  if (appLinks && Object.hasOwn(appLinks, href)) return <button type="button" className="md-link" onClick={appLinks[href]}>{children}</button>;
  if (/^https?:\/\//i.test(href))
    return (
      <a
        className="md-link"
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (api.available()) {
            e.preventDefault();
            void api.openExternal(href).catch(toast.error);
          }
        }}
      >
        {children}
      </a>
    );
  if (id && onDocument && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href))
    return (
      <button
        className="md-link"
        onClick={() => {
          try {
            void api
              .documentLink(id, decodeURIComponent(href.split("#")[0]))
              .then(onDocument)
              .catch(toast.error);
          } catch (e) {
            toast.error(e);
          }
        }}
      >
        {children}
      </button>
    );
  return <span>{children}</span>;
}

function InlineCitation({number}:{number:number}) { const {citation}=useContext(DocumentContext); return <>{citation ? citation(number) : `[${number}]`}</>; }
