import * as D from "@radix-ui/react-dialog";
import { Check, LoaderCircle, PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react";
import { cx } from "../lib/cx.ts";
import type { Route } from "../lib/router.ts";
import { ANALYSIS, ARCHIVE, OPERATIONS, sectionOf, type NavItem } from "./nav.ts";
import { Brand } from "./Brand.tsx";
import { useApp } from "./AppContext.tsx";

/**
 * "full" is the labelled sidebar, "rail" the icon strip, and "drawer" the labelled sidebar shown
 * over the content when the window is too narrow to keep it open.
 */
export type SidebarMode = "full" | "rail" | "drawer";

export function Sidebar({ mode, onToggle, onNavigate }: { mode: SidebarMode; onToggle: () => void; onNavigate?: () => void }) {
  const { route, navigate, overview, activeJob, openActivity } = useApp();
  const rail = mode === "rail";
  const current = sectionOf(route.page);
  const go = (r: Route) => {
    navigate(r);
    onNavigate?.();
  };
  const item = (n: NavItem) => (
    <button
      key={n.page}
      type="button"
      className={cx("nav-item", current === n.page && "is-active")}
      aria-current={current === n.page ? "page" : undefined}
      data-tip={rail ? n.label : undefined}
      onClick={() => go(n.route)}
    >
      <n.icon size={18} aria-hidden />
      <span className="nav-label">{n.label}</span>
      {n.page === "library" && overview && !rail && <span className="nav-count num">{overview.media.toLocaleString("en-US")}</span>}
    </button>
  );
  const settingsActive = route.page === "settings";
  const toggleLabel = mode === "full" ? "Collapse sidebar" : mode === "rail" ? "Open sidebar" : "Close sidebar";
  return (
    <aside className={cx("sidebar", rail && "is-rail", mode === "drawer" && "is-drawer")} aria-label="Main navigation">
      <div className="sidebar-brand">
        <button type="button" className="brand-button" onClick={() => go({ page: "library" })} aria-label="Concord library">
          <Brand compact={rail} />
        </button>
        <button type="button" className="sidebar-toggle" onClick={onToggle} aria-label={toggleLabel} data-tip={rail ? toggleLabel : undefined}>
          {rail ? <PanelLeftOpen size={17} aria-hidden /> : <PanelLeftClose size={17} aria-hidden />}
        </button>
      </div>
      <nav className="sidebar-nav">
        {!rail && <div className="nav-group">Archive</div>}
        {ARCHIVE.map(item)}
        {rail ? <div className="nav-divider" /> : <div className="nav-group">Analysis</div>}
        {ANALYSIS.map(item)}
        {rail ? <div className="nav-divider" /> : <div className="nav-group">Processing</div>}
        {OPERATIONS.map(item)}
      </nav>
      <div className="sidebar-foot">
        <button
          type="button"
          className={cx("nav-item activity-item", activeJob && "is-busy")}
          onClick={() => {
            onNavigate?.();
            openActivity();
          }}
          data-tip={rail ? (activeJob ? `Transcribing ${activeJob.title}` : "Status & Health") : undefined}
        >
          {activeJob ? <LoaderCircle size={18} className="spin" aria-hidden /> : <Check size={18} aria-hidden />}
          <span className="nav-label activity-text">
            {activeJob ? (
              <>
                <b>{activeJob.title}</b>
                <small>{activeJob.message || "Processing"}</small>
              </>
            ) : (
              "Status & Health"
            )}
          </span>
        </button>
        <button
          type="button"
          className={cx("nav-item", settingsActive && "is-active")}
          aria-current={settingsActive ? "page" : undefined}
          data-tip={rail ? "Settings" : undefined}
          onClick={() => go({ page: "settings" })}
        >
          <Settings2 size={18} aria-hidden />
          <span className="nav-label">Settings</span>
        </button>
      </div>
    </aside>
  );
}

/** The labelled sidebar over the content, for windows too narrow to keep it open. */
export function SidebarDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="overlay nav-drawer-overlay" />
        <D.Content className="nav-drawer" aria-describedby={undefined}>
          <D.Title className="sr-only">Navigation</D.Title>
          <Sidebar mode="drawer" onToggle={() => onOpenChange(false)} onNavigate={() => onOpenChange(false)} />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
