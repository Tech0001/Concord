import { useState } from "react";
import { Activity, MessageCircle, FileText, Library, MoreHorizontal, Network, NotebookPen, Search, Settings2, Users } from "lucide-react";
import { cx } from "../lib/cx.ts";
import type { Route } from "../lib/router.ts";
import { Sheet } from "../ui/Dialog.tsx";
import { sectionOf } from "./nav.ts";
import { useApp } from "./AppContext.tsx";

const TABS = [
  { page: "library", label: "Library", icon: Library, route: { page: "library" } },
  { page: "search", label: "Search", icon: Search, route: { page: "search", q: "" } },
  { page: "notes", label: "Notes", icon: NotebookPen, route: { page: "notes" } },
  { page: "speakers", label: "Speakers", icon: Users, route: { page: "speakers" } },
] as const;

export function TabBar() {
  const { route, navigate, openActivity } = useApp();
  const [more, setMore] = useState(false);
  const current = sectionOf(route.page);
  const inMore = ["documents", "map", "ai", "settings"].includes(current);
  const go = (r: Route) => {
    setMore(false);
    navigate(r);
  };
  return (
    <>
      <nav className="tabbar" aria-label="Main navigation">
        {TABS.map((t) => (
          <button
            key={t.page}
            type="button"
            className={cx("tab", current === t.page && "is-active")}
            aria-current={current === t.page ? "page" : undefined}
            onClick={() => navigate(t.route)}
          >
            <t.icon size={20} aria-hidden />
            <span>{t.label}</span>
          </button>
        ))}
        <button type="button" className={cx("tab", inMore && "is-active")} onClick={() => setMore(true)}>
          <MoreHorizontal size={20} aria-hidden />
          <span>More</span>
        </button>
      </nav>
      <Sheet open={more} onOpenChange={setMore} title="More">
        <div className="menu-list">
          <button type="button" role="menuitem" className="menu-item" onClick={() => go({ page: "documents" })}>
            <FileText size={17} aria-hidden /> Docs
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => go({ page: "map" })}>
            <Network size={17} aria-hidden /> Map
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => go({ page: "ai" })}><MessageCircle size={17} aria-hidden /> AI</button>
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setMore(false);
              openActivity();
            }}
          >
            <Activity size={17} aria-hidden /> Status &amp; Health
          </button>
          <button type="button" role="menuitem" className="menu-item" onClick={() => go({ page: "settings" })}>
            <Settings2 size={17} aria-hidden /> Settings
          </button>
        </div>
      </Sheet>
    </>
  );
}
