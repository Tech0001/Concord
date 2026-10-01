import { ToolIndicator } from "../tools/ToolsContext.tsx";
import { Plus, Search } from "lucide-react";
import { PHONE, useMediaQuery } from "../lib/media-query.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import type { Category } from "../lib/types.ts";
import { Kbd } from "../ui/Kbd.tsx";
import { Brand } from "./Brand.tsx";
import { PAGE_TITLES } from "./nav.ts";
import { useApp } from "./AppContext.tsx";

export function Topbar({ onAdd }: { onAdd: () => void }) {
  const { route, pageTitle, openPalette, category, setCategory } = useApp();
  const phone = useMediaQuery(PHONE);
  const scoped = ["library", "search", "documents", "notes", "map", "ai", "pipeline"].includes(route.page);
  const categories: {value: Category; label: string}[] = [{value:"personal",label:"Personal"},{value:"work",label:"Work"},{value:"",label:"Both"}];
  const title = pageTitle ?? PAGE_TITLES[route.page];
  if (phone)
    return (
      <header className="topbar">
        <Brand compact />
        <h2 className="topbar-title">{title}</h2>
        {scoped && <Select size="sm" label="Archive category" value={category} onChange={setCategory} options={categories}/> }
        <ToolIndicator/>
        <IconButton label="Search or jump to" icon={Search} onClick={openPalette} />
        {route.page === "library" && <IconButton label="Add recordings" icon={Plus} onClick={onAdd} />}
      </header>
    );
  return (
    <header className="topbar">
      <button type="button" className="palette-trigger" onClick={openPalette}>
        <Search size={15} aria-hidden />
        <span>Search or jump to…</span>
        <Kbd>Ctrl K</Kbd>
      </button>
      <div className="topbar-actions">
        <ToolIndicator/>
        {scoped && <Segmented label="Archive category" value={category} onChange={setCategory} options={categories}/>}
        <Button variant="primary" icon={Plus} onClick={onAdd}>
          Add recordings
        </Button>
      </div>
    </header>
  );
}
