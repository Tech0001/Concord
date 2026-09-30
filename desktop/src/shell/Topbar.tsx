import { Plus, Search } from "lucide-react";
import { PHONE, useMediaQuery } from "../lib/media-query.ts";
import { Button, IconButton } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Brand } from "./Brand.tsx";
import { PAGE_TITLES } from "./nav.ts";
import { useApp } from "./AppContext.tsx";

export function Topbar({ onAdd }: { onAdd: () => void }) {
  const { route, pageTitle, openPalette } = useApp();
  const phone = useMediaQuery(PHONE);
  const title = pageTitle ?? PAGE_TITLES[route.page];
  if (phone)
    return (
      <header className="topbar">
        <Brand compact />
        <h2 className="topbar-title">{title}</h2>
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
        <Button variant="primary" icon={Plus} onClick={onAdd}>
          Add recordings
        </Button>
      </div>
    </header>
  );
}
