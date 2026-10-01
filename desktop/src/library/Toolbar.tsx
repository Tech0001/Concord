import { useState } from "react";
import { LayoutGrid, List, Search, SlidersHorizontal, Star, X } from "lucide-react";
import { STATUS_OPTIONS } from "./model.ts";
import type { LibraryFilter, LibrarySort } from "../lib/types.ts";
import { Button } from "../ui/Button.tsx";
import { Panel } from "../ui/Menu.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { Select } from "../ui/Select.tsx";

export const SORTS: { value: LibrarySort; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "opened", label: "Recently opened" },
  { value: "words", label: "Most words" },
  { value: "title", label: "Title" },
  { value: "longest", label: "Longest" },
];

export function activeFilterCount(f: LibraryFilter): number {
  return [f.kind, f.transcribed, f.review, f.status].filter(Boolean).length + (f.starred ? 1 : 0);
}

export function Toolbar({
  filter,
  update,
  channels,
  view,
  setView,
  showView,
  compact,
}: {
  filter: LibraryFilter;
  update: (patch: Partial<LibraryFilter>) => void;
  channels: string[];
  view: "grid" | "list";
  setView: (v: "grid" | "list") => void;
  showView: boolean;
  /** Narrow screens move sorting into the filter panel. */
  compact: boolean;
}) {
  const [open, setOpen] = useState(false);
  const active = activeFilterCount(filter);
  const sort = <Select label="Sort" value={filter.sort} onChange={(sort) => update({ sort })} options={SORTS} />;
  return (
    <div className="lib-toolbar">
      <label className="search-field library-search">
        <Search size={15} aria-hidden />
        <input
          type="search"
          aria-label="Filter recordings"
          placeholder="Filter by title, collection, or file…"
          value={filter.query}
          onChange={(e) => update({ query: e.target.value })}
          onKeyDown={(e) => e.key === "Escape" && update({ query: "" })}
        />
      </label>
      <Select
        label="Collection"
        value={filter.channel}
        onChange={(channel) => update({ channel })}
        options={[{ value: "", label: "All collections" }, ...channels.map((c) => ({ value: c, label: c }))]}
      />
      <Panel
        title="Filters"
        open={open}
        onOpenChange={setOpen}
        trigger={
          <Button icon={SlidersHorizontal} data-filters-trigger="" className={active ? "has-filters" : undefined}>
            Filters{active > 0 && <span className="filter-count num">{active}</span>}
          </Button>
        }
      >
        <div className="filter-panel">
          {compact && (
            <div className="filter-group">
              <span className="filter-label">Sort</span>
              {sort}
            </div>
          )}
          <div className="filter-group"><span className="filter-label">Processing status</span><Select label="Recording status" value={filter.status} onChange={status => update({ status })} options={STATUS_OPTIONS}/></div>
          <div className="filter-group">
            <span className="filter-label">Type</span>
            <Segmented
              label="Type"
              value={filter.kind}
              onChange={(kind) => update({ kind })}
              options={[
                { value: "", label: "All" },
                { value: "audio", label: "Audio" },
                { value: "video", label: "Video" },
              ]}
            />
          </div>
          <div className="filter-group">
            <span className="filter-label">Transcript</span>
            <Segmented
              label="Transcript"
              value={filter.transcribed}
              onChange={(transcribed) => update({ transcribed })}
              options={[
                { value: "", label: "Any" },
                { value: "yes", label: "Transcribed" },
                { value: "no", label: "Not yet" },
              ]}
            />
          </div>
          <div className="filter-group">
            <span className="filter-label">Review</span>
            <Segmented
              label="Review"
              value={filter.review}
              onChange={(review) => update({ review })}
              options={[
                { value: "", label: "Any" },
                { value: "unreviewed", label: "Unreviewed" },
                { value: "in_review", label: "In review" },
                { value: "reviewed", label: "Reviewed" },
              ]}
            />
          </div>
          <div className="filter-foot">
            <Button icon={Star} className="toggle-btn" aria-pressed={filter.starred} onClick={() => update({ starred: !filter.starred })}>
              Starred only
            </Button>
            <Button
              variant="ghost"
              icon={X}
              disabled={!active}
              onClick={() => update({ kind: "", transcribed: "", review: "", status: "", starred: false })}
            >
              Reset
            </Button>
          </div>
        </div>
      </Panel>
      {!compact && (
        <>
          <div className="toolbar-spacer" />
          {sort}
        </>
      )}
      {showView && (
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: "grid", label: "Grid", icon: LayoutGrid, iconOnly: true },
            { value: "list", label: "List", icon: List, iconOnly: true },
          ]}
        />
      )}
    </div>
  );
}
