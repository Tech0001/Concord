import { PageHeader } from "../ui/PageHeader.tsx";
import { SearchPanel } from "../ai/SearchPanel.tsx";
import "./search.css";
export function SearchPage({ q }: { q: string }) {
  return (
    <div className="search-page">
      <PageHeader title="Search" />
      <SearchPanel semantic={false} q={q} />
    </div>
  );
}
