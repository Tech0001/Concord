import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, FileText, Plus, Search } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { count } from "../lib/format.ts";
import type { DocumentBody, Research } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { Markdown } from "./Markdown.tsx";
import "./documents.css";

function humanLength(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000).toLocaleString("en-US")}k characters` : count(n, "character");
}

export function DocumentsPage({ id }: { id?: string }) {
  return id ? <DocumentReader id={id} /> : <DocumentList />;
}

function DocumentList() {
  const { navigate, revision, refresh } = useApp();
  const toast = useToast();
  const [docs, setDocs] = useState<Research["docs"]>();
  const [query, setQuery] = useState("");
  useEffect(() => {
    api
      .research()
      .then((r) => setDocs(r.docs))
      .catch(toast.error);
  }, [revision, toast]);
  const add = async () => {
    try {
      const paths = await api.pickDocuments();
      if (!paths.length) return;
      const n = await api.importDocuments(paths);
      toast.success(`${count(n, "document")} added`);
      refresh();
    } catch (e) {
      toast.error(e);
    }
  };
  const shown = (docs ?? []).filter((d) => d.title.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="docs-page">
      <PageHeader
        title="Documents"
        meta={docs ? count(docs.length, "document") : "Loading…"}
        actions={
          <Button variant="primary" icon={Plus} onClick={() => void add()}>
            Add documents
          </Button>
        }
      />
      {docs && docs.length > 0 && (
        <label className="search-field docs-filter">
          <Search size={15} aria-hidden />
          <input type="search" aria-label="Filter documents" placeholder="Filter by title…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      )}
      <ul className="doc-list">
        {shown.map((d) => (
          <li key={d.id}>
            <button type="button" className="doc-row" onClick={() => navigate({ page: "documents", id: d.id })}>
              <FileText size={17} aria-hidden />
              <span className="doc-row-title">{d.title}</span>
              <span className="doc-row-size num">{humanLength(d.length)}</span>
              <ChevronRight size={15} aria-hidden className="doc-row-chevron" />
            </button>
          </li>
        ))}
      </ul>
      {docs && !docs.length && (
        <Empty icon={FileText} title="A home for your sources" text="Add Markdown or plain-text documents to keep them beside your recordings." />
      )}
      {docs && docs.length > 0 && !shown.length && <Empty icon={Search} title="No documents match" text="Try a different title." />}
    </div>
  );
}

function DocumentReader({ id }: { id: string }) {
  const { navigate, setPageTitle, openNote } = useApp();
  const toast = useToast();
  const [doc, setDoc] = useState<DocumentBody>();
  const [passage, setPassage] = useState("");
  useEffect(() => {
    const selection = () => {
      const s = getSelection(); const paper = document.querySelector(".doc-paper");
      if (s && !s.isCollapsed && paper?.contains(s.anchorNode) && paper.contains(s.focusNode)) setPassage(s.toString().trim());
    };
    document.addEventListener("selectionchange", selection);
    return () => document.removeEventListener("selectionchange", selection);
  }, []);
  useEffect(() => {
    api
      .document(id)
      .then(setDoc)
      .catch(toast.error);
  }, [id, toast]);
  useEffect(() => {
    if (!doc) return;
    setPageTitle(doc.title);
    return () => setPageTitle(null);
  }, [doc, setPageTitle]);
  return (
    <article className="doc-reader">
      <Button variant="ghost" size="sm" icon={ArrowLeft} className="doc-back" onClick={() => navigate({ page: "documents" })}>
        Documents
      </Button>
      {doc && (
        <>
          <h1 className="doc-title">{doc.title}</h1>
          {passage && <div className="document-selection"><Button variant="primary" onClick={() => openNote({ title: `${doc.title} · passage`, body: "", anchors: [{ doc_id: doc.id, title: doc.title, quote: passage }] })}>Save passage as note</Button><span className="muted">{passage.length} characters selected</span><Button variant="ghost" size="sm" onClick={() => { setPassage(""); getSelection()?.removeAllRanges(); }}>Clear</Button></div>}
          <div className="doc-paper">
            {doc.body.trim() ? (
              <Markdown source={doc.body} />
            ) : (
              <Empty icon={FileText} title="No text was indexed" text="Import the original Markdown file to read it here." />
            )}
          </div>
        </>
      )}
    </article>
  );
}
