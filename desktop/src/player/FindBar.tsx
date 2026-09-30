import { forwardRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { IconButton } from "../ui/Button.tsx";

export const FindBar = forwardRef<
  HTMLInputElement,
  { query: string; setQuery: (q: string) => void; index: number; total: number; step: (delta: number) => void }
>(function FindBar({ query, setQuery, index, total, step }, ref) {
  return (
    <div className="find-bar">
      <label className="search-field find-field">
        <Search size={15} aria-hidden />
        <input
          ref={ref}
          type="search"
          aria-label="Find in transcript"
          placeholder="Find in transcript"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              step(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setQuery("");
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      {query.trim() && (
        <>
          <span className="find-count num" aria-live="polite">
            {total ? `${index + 1} of ${total}` : "No matches"}
          </span>
          <IconButton label="Previous match" icon={ChevronUp} size="sm" disabled={!total} onClick={() => step(-1)} />
          <IconButton label="Next match" icon={ChevronDown} size="sm" disabled={!total} onClick={() => step(1)} />
          <IconButton label="Clear find" icon={X} size="sm" onClick={() => setQuery("")} />
        </>
      )}
    </div>
  );
});
