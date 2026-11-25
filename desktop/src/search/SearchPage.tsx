import { useState } from "react";
import type { SearchMode } from "../lib/router.ts";
import { useApp } from "../shell/AppContext.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { SearchPanel } from "../ai/SearchPanel.tsx";
import "./search.css";

export function SearchPage({ q, mode = "keywords" }: { q: string; mode?: SearchMode }) {
  const { navigate } = useApp();
  const [draft, setDraft] = useState(q);
  const semantic = mode === "meaning";

  const switchMode = (next: SearchMode) => {
    navigate(
      { page: "search", q: draft || q, mode: next === "meaning" ? "meaning" : undefined },
      { replace: true },
    );
  };

  return (
    <div className="search-page">
      <PageHeader
        title="Search"
        actions={
          <Segmented<SearchMode>
            label="Search mode"
            value={mode}
            onChange={switchMode}
            options={[
              { value: "keywords", label: "Keywords" },
              { value: "meaning", label: "By meaning" },
            ]}
          />
        }
      />
      <SearchPanel
        semantic={semantic}
        q={q}
        onQueryChange={setDraft}
        onSwitchMode={switchMode}
      />
    </div>
  );
}
