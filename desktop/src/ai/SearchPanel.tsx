import { useEffect, useRef, useState } from "react";
import { FileText, NotebookPen, Play, Search } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { GroupedResults } from "../search/GroupedResults.tsx";
import { highlightParts } from "../lib/search.ts";
import { clock } from "../lib/format.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Empty } from "../ui/Empty.tsx";
import { useToast } from "../ui/Toasts.tsx";
import {
  EMPTY_FILTER,
  type SearchFilter,
  type FilterOptions,
  type ResearchHit,
} from "./types.ts";
import "./ai.css";
export function SearchFilters({
  filter,
  onChange,
}: {
  filter: SearchFilter;
  onChange: (f: SearchFilter) => void;
}) {
  const [options, setOptions] = useState<FilterOptions>();
  const toast = useToast();
  useEffect(() => {
    api.searchFilters().then(setOptions).catch(toast.error);
  }, [toast]);
  const change = (key: keyof SearchFilter, value: string) =>
    onChange({ ...filter, [key]: value });
  return (
    <details className="research-filters">
      <summary>
        Filters{Object.entries(filter).some(([k,v]) => k !== "exact" && !!v) ? " · active" : ""}
      </summary>
      <div className="ai-filter-grid">
        <Select
          label="Source type"
          value={filter.kind || "all"}
          onChange={(v) => change("kind", v === "all" ? "" : v)}
          options={[
            { value: "all", label: "All sources" },
            { value: "recording", label: "Recordings" },
            { value: "document", label: "Documents" },
            { value: "note", label: "Notes" },
          ]}
        />
        <Select
          label="Collection"
          value={filter.channel || "all"}
          onChange={(v) => change("channel", v === "all" ? "" : v)}
          options={[
            { value: "all", label: "All collections" },
            ...(options?.channels ?? [])
              .filter((c) => c.channel)
              .map((c) => ({ value: c.channel, label: c.channel })),
          ]}
        />
        <Select
          label="Speaker"
          value={filter.speaker || "all"}
          onChange={(v) => change("speaker", v === "all" ? "" : v)}
          options={[
            { value: "all", label: "All speakers" },
            ...(options?.speakers ?? []).map((s) => ({
              value: s.id,
              label: s.name,
            })),
          ]}
        />
        <Select
          label="Tag"
          value={filter.tag || "all"}
          onChange={(v) => change("tag", v === "all" ? "" : v)}
          options={[
            { value: "all", label: "All tags" },
            ...(options?.tags ?? []).map((t) => ({
              value: t.tag,
              label: t.tag,
            })),
          ]}
        />
      </div>
      <div className="ai-date-filters">
        <div className="ai-date-range">
          <label className="field">
            <span>From</span>
            <input
              type="date"
              aria-label="From date"
              value={filter.from}
              onChange={(e) => change("from", e.target.value)}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              aria-label="To date"
              value={filter.to}
              onChange={(e) => change("to", e.target.value)}
            />
          </label>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange({ ...EMPTY_FILTER })}
        >
          Reset filters
        </Button>
      </div>
      <small className="muted">
        Speaker and collection filters apply to recordings. Tags include notes
        and their evidence sources.
      </small>
    </details>
  );
}
export function SourceHit({
  hit,
  number,
  onNavigate,
}: {
  hit: ResearchHit;
  number?: number;
  onNavigate?: () => void;
}) {
  const { navigate, openNote } = useApp();
  const toast = useToast();
  const open = async () => {
    onNavigate?.();
    if (hit.kind === "recording")
      navigate({ page: "recording", id: hit.id, at: hit.start ?? 0 });
    else if (hit.kind === "document")
      navigate({ page: "documents", id: hit.id });
    else {
      try {
        const note = (await api.research()).notes.find((n) => n.id === hit.id);
        if (note) openNote(note);
        else toast.error("This note has been deleted");
      } catch (e) {
        toast.error(e);
      }
    }
  };
  const Icon =
    hit.kind === "recording"
      ? Play
      : hit.kind === "document"
        ? FileText
        : NotebookPen;
  return (
    <button className="research-hit" onClick={() => void open()}>
      <div className="research-hit-title">
        <Icon size={15} />
        <strong>
          {number != null && `[${number}] `}
          {hit.title}
        </strong>
        {hit.start != null && <span className="mono">{clock(hit.start)}</span>}
      </div>
      <small className="muted">
        {[hit.kind, hit.channel, hit.date].filter(Boolean).join(" · ")}
      </small>
      <p>{highlightParts(hit.marked ?? hit.text).map((p, i) => p.mark ? <mark key={i}>{p.text}</mark> : p.text)}</p>
    </button>
  );
}
export function SearchPanel({
  semantic,
  q = "",
}: {
  semantic: boolean;
  q?: string;
}) {
  const [text, setText] = useState(q);
  const [filter, setFilter] = useState<SearchFilter>({ ...EMPTY_FILTER });
  const [hits, setHits] = useState<ResearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const { navigate, category } = useApp();
  useEffect(() => {
    setText(q);
  }, [q]);
  const run = async (query: string) => {
    const n = ++serial.current;
    setLoading(true);
    setError("");
    setSearched(true);
    try {
      const result = await api.researchSearch(query, semantic, { ...filter, category });
      if (n === serial.current) setHits(result);
    } catch (e) {
      if (n === serial.current) {
        setHits([]);
        setError(String(e instanceof Error ? e.message : e));
      }
    } finally {
      if (n === serial.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (!semantic && q.trim()) void run(q);
    else if (semantic) { setHits([]); setSearched(false); }
    else if (!q.trim() && !semantic) {
      setHits([]);
      setSearched(false);
    }
    return () => {
      serial.current++;
    };
  }, [q, semantic, filter, category]);
  const submit = () => {
    if (!text.trim()) return;
    if (!semantic && text !== q) navigate({ page: "search", q: text }, { replace: true });
    else void run(text);
  };
  return (
    <div className="research-search">
      <form
        className="ai-search-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="search-hero">
          <Search size={20} />
          <input
            type="search"
            aria-label={
              semantic ? "Semantic search query" : "Search every transcript"
            }
            placeholder={
              semantic
                ? "Describe the idea you want to find…"
                : "A name, a phrase, or a word you remember…"
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <Button
          variant="primary"
          disabled={loading || !text.trim()}
          type="submit"
        >
          {loading ? "Searching…" : "Search"}
        </Button>
      </form>
      {!semantic && <div className="search-match-mode"><Select label="Word matching" value={filter.exact ? "phrase" : "words"} onChange={v => setFilter({ ...filter, exact: v === "phrase" })} options={[{ value: "words", label: "All words" }, { value: "phrase", label: "Exact phrase" }]}/><small className="muted">{filter.exact ? "Find these words together, in this order." : "Find passages containing every word."}</small></div>}
      <SearchFilters filter={filter} onChange={setFilter} />
      {error && (
        <p role="alert" className="is-error">
          {error}
        </p>
      )}
      {searched && !error && (
        <p className="muted" role="status">
          {loading
            ? "Finding passages…"
            : `${hits.length} matching passages${hits.length === 100 ? " · first 100" : ""}`}
        </p>
      )}
      {!semantic ? <GroupedResults hits={hits} renderOther={hit => <SourceHit hit={hit}/>} /> : <div className="research-results">
        {hits.map((hit, i) => (
          <SourceHit
            key={`${hit.kind}:${hit.id}:${hit.start}:${i}`}
            hit={hit}
          />
        ))}
      </div>}
      {!searched && (
        <Empty
          icon={Search}
          title={
            semantic
              ? "Find ideas, even in different words"
              : "Search your library"
          }
          text={
            semantic
              ? "Find related passages without asking a chat model to write an answer."
              : "Search words across transcripts, documents and notes. No AI provider is used."
          }
        />
      )}
      {searched && !loading && !error && !hits.length && (
        <Empty
          icon={Search}
          title="No matching passages"
          text="Try a broader query or fewer filters."
        />
      )}
    </div>
  );
}
