import { useCallback, useEffect, useRef, useState } from "react";
import {
  Database,
  FileText,
  NotebookPen,
  Play,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { GroupedResults } from "../search/GroupedResults.tsx";
import { highlightParts } from "../lib/search.ts";
import { clock } from "../lib/format.ts";
import type { SearchMode } from "../lib/router.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Select } from "../ui/Select.tsx";
import { Empty } from "../ui/Empty.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { IndexControl } from "./IndexControl.tsx";
import {
  EMPTY_FILTER,
  type SearchFilter,
  type FilterOptions,
  type IndexStatus,
  type ResearchHit,
} from "./types.ts";
import "./ai.css";

function countActiveFilters(filter: SearchFilter): number {
  return (["kind", "channel", "speaker", "from", "to", "tag"] as const).filter(
    (k) => !!filter[k],
  ).length;
}

function FilterFields({
  filter,
  onChange,
  options,
}: {
  filter: SearchFilter;
  onChange: (f: SearchFilter) => void;
  options?: FilterOptions;
}) {
  const change = (key: keyof SearchFilter, value: string) =>
    onChange({ ...filter, [key]: value });
  return (
    <>
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
          onClick={() => onChange({ ...EMPTY_FILTER, exact: filter.exact })}
        >
          Reset filters
        </Button>
      </div>
      <small className="muted">
        Speaker and collection filters apply to recordings. Tags include notes
        and their evidence sources.
      </small>
    </>
  );
}

/** Used inside the Ask Concord filter popover. */
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
  const active = countActiveFilters(filter);
  return (
    <details className="research-filters">
      <summary>Filters{active ? ` · ${active}` : ""}</summary>
      <FilterFields filter={filter} onChange={onChange} options={options} />
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
      <p>
        {highlightParts(hit.marked ?? hit.text).map((p, i) =>
          p.mark ? <mark key={i}>{p.text}</mark> : p.text,
        )}
      </p>
    </button>
  );
}

export function SearchPanel({
  semantic,
  q = "",
  onQueryChange,
  onSwitchMode,
}: {
  semantic: boolean;
  q?: string;
  onQueryChange?: (q: string) => void;
  onSwitchMode?: (mode: SearchMode) => void;
}) {
  const [text, setText] = useState(q);
  const [filter, setFilter] = useState<SearchFilter>({ ...EMPTY_FILTER });
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [options, setOptions] = useState<FilterOptions>();
  const [hits, setHits] = useState<ResearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const [indexStatus, setIndexStatus] = useState<IndexStatus>();
  const [showIndexCard, setShowIndexCard] = useState(false);
  const serial = useRef(0);
  const { navigate, category } = useApp();
  const toast = useToast();

  useEffect(() => {
    setText(q);
  }, [q]);

  useEffect(() => {
    api.searchFilters().then(setOptions).catch(toast.error);
  }, [toast]);

  const onIndexStatus = useCallback((next: IndexStatus) => {
    setIndexStatus(next);
  }, []);

  useEffect(() => {
    if (!semantic) return;
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const next = await api.aiStatus();
        if (alive) setIndexStatus(next);
      } catch {
        /* Handled if user opens index controls or searches. */
      }
      if (alive) timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [semantic]);

  const run = async (query: string) => {
    const n = ++serial.current;
    setLoading(true);
    setError("");
    setSearched(true);
    try {
      const result = await api.researchSearch(query, semantic, {
        ...filter,
        category,
      });
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
    if (!q.trim()) {
      setHits([]);
      setSearched(false);
      setError("");
      return;
    }
    if (!semantic) {
      void run(q);
    } else if (indexStatus && indexStatus.indexed > 0) {
      void run(q);
    } else {
      setHits([]);
      setSearched(false);
      setError("");
    }
    return () => {
      serial.current++;
    };
  }, [q, semantic, filter, category, indexStatus?.indexed]);

  const submit = () => {
    if (!text.trim()) return;
    const mode = semantic ? "meaning" : undefined;
    if (text !== q) {
      navigate({ page: "search", q: text, mode }, { replace: true });
    }
    void run(text);
  };

  const activeFilters = countActiveFilters(filter);
  const indexEmpty = !!indexStatus && indexStatus.indexed === 0;
  const indexRunning = indexStatus?.job?.status === "running";
  const indexStale =
    !!indexStatus && indexStatus.indexed > 0 && indexStatus.indexed < indexStatus.total;
  const needsIndexBanner =
    semantic && (indexEmpty || indexRunning || showIndexCard || indexStatus?.job?.status === "failed");

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
          <Search size={20} aria-hidden />
          <input
            type="search"
            aria-label={
              semantic ? "Search by meaning" : "Search every transcript"
            }
            placeholder={
              semantic
                ? "Describe an idea or topic — even in different words…"
                : "A name, a phrase, or a word you remember…"
            }
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              onQueryChange?.(e.target.value);
            }}
          />
        </label>
        <Button
          variant="primary"
          disabled={loading || !text.trim() || (semantic && indexEmpty)}
          type="submit"
        >
          {loading ? "Searching…" : "Search"}
        </Button>
      </form>

      <div className="search-toolbar">
        {!semantic ? (
          <div className="search-mode-inline">
            <Segmented<"words" | "phrase">
              size="sm"
              label="Word matching"
              value={filter.exact ? "phrase" : "words"}
              onChange={(v) => setFilter({ ...filter, exact: v === "phrase" })}
              options={[
                { value: "words", label: "All words" },
                { value: "phrase", label: "Exact phrase" },
              ]}
            />
          </div>
        ) : (
          <div className="search-index-bar">
            {indexStatus && !needsIndexBanner && (
              <>
                <span className="search-index-pill">
                  <Database size={13} aria-hidden />
                  {indexStatus.indexed.toLocaleString()} /{" "}
                  {indexStatus.total.toLocaleString()} indexed
                  {indexStatus.device ? ` · ${indexStatus.device}` : ""}
                </span>
                {indexStale && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={RefreshCw}
                    onClick={() => setShowIndexCard(true)}
                  >
                    Update index
                  </Button>
                )}
              </>
            )}
          </div>
        )}
        <div className="search-toolbar-right">
          {activeFilters > 0 && (
            <Button
              size="sm"
              variant="ghost"
              icon={X}
              onClick={() => setFilter({ ...EMPTY_FILTER, exact: filter.exact })}
            >
              Clear ({activeFilters})
            </Button>
          )}
          <Button
            size="sm"
            variant={filtersOpen || activeFilters > 0 ? "secondary" : "ghost"}
            icon={SlidersHorizontal}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen((v) => !v)}
          >
            Filters{activeFilters ? ` · ${activeFilters}` : ""}
          </Button>
        </div>
      </div>

      {filtersOpen && (
        <div className="search-filter-tray">
          <FilterFields filter={filter} onChange={setFilter} options={options} />
        </div>
      )}

      {needsIndexBanner && (
        <div className="search-index-card">
          <IndexControl compact onStatus={onIndexStatus} />
          <div className="search-index-card-foot">
            {indexEmpty && text.trim() && onSwitchMode && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSwitchMode("keywords")}
              >
                Search “{text.trim()}” by keywords instead
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={Settings2}
              onClick={() => navigate({ page: "settings", section: "ai" })}
            >
              AI &amp; Search settings
            </Button>
            {!indexEmpty && !indexRunning && showIndexCard && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowIndexCard(false)}
              >
                Hide
              </Button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="search-error-banner">
          <p className="is-error">{error}</p>
          <div className="search-error-actions">
            {semantic && onSwitchMode && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onSwitchMode("keywords")}
              >
                Search by keywords
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={Settings2}
              onClick={() => navigate({ page: "settings", section: "ai" })}
            >
              AI &amp; Search settings
            </Button>
          </div>
        </div>
      )}

      {searched && !error && (
        <p className="muted" role="status">
          {loading
            ? "Finding passages…"
            : `${hits.length} matching ${hits.length === 1 ? "passage" : "passages"}${hits.length === 100 ? " · first 100" : ""}`}
        </p>
      )}

      {!semantic ? (
        <GroupedResults
          hits={hits}
          renderOther={(hit) => <SourceHit hit={hit} />}
        />
      ) : (
        <div className="research-results">
          {hits.map((hit, i) => (
            <SourceHit
              key={`${hit.kind}:${hit.id}:${hit.start}:${i}`}
              hit={hit}
            />
          ))}
        </div>
      )}

      {!searched && !needsIndexBanner && (
        <Empty
          icon={Search}
          title={
            semantic
              ? "Find ideas, even in different words"
              : "Search your library"
          }
          text={
            semantic
              ? "Search by topic or meaning across transcripts, documents, and notes — no chat model needed."
              : "Search exact words or phrases across transcripts, documents, and notes. Instant and local."
          }
        />
      )}

      {searched && !loading && !error && !hits.length && (
        <Empty
          icon={Search}
          title="No matching passages"
          text={
            semantic
              ? "Try phrasing the idea differently, switching to Keywords, or using fewer filters."
              : "Try fewer words, switching to By meaning, or clearing filters."
          }
        />
      )}
    </div>
  );
}
