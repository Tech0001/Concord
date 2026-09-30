import { Check, LoaderCircle, PanelLeftClose, PanelLeftOpen, Settings2 } from "lucide-react";
import { cx } from "../lib/cx.ts";
import { ANALYSIS, ARCHIVE, sectionOf, type NavItem } from "./nav.ts";
import { Brand } from "./Brand.tsx";
import { useApp } from "./AppContext.tsx";

export function Sidebar({ rail, canCollapse, onToggle }: { rail: boolean; canCollapse: boolean; onToggle: () => void }) {
  const { route, navigate, overview, activeJob, openActivity } = useApp();
  const current = sectionOf(route.page);
  const item = (n: NavItem) => (
    <button
      key={n.page}
      type="button"
      className={cx("nav-item", current === n.page && "is-active")}
      aria-current={current === n.page ? "page" : undefined}
      data-tip={rail ? n.label : undefined}
      onClick={() => navigate(n.route)}
    >
      <n.icon size={18} aria-hidden />
      <span className="nav-label">{n.label}</span>
      {n.page === "library" && overview && !rail && <span className="nav-count num">{overview.media.toLocaleString("en-US")}</span>}
    </button>
  );
  const settingsActive = route.page === "settings";
  return (
    <aside className={cx("sidebar", rail && "is-rail")} aria-label="Main navigation">
      <div className="sidebar-brand">
        <button type="button" className="brand-button" onClick={() => navigate({ page: "library" })} aria-label="Concord library">
          <Brand compact={rail} />
        </button>
      </div>
      <nav className="sidebar-nav">
        {!rail && <div className="nav-group">Archive</div>}
        {ARCHIVE.map(item)}
        {rail ? <div className="nav-divider" /> : <div className="nav-group">Analysis</div>}
        {ANALYSIS.map(item)}
      </nav>
      <div className="sidebar-foot">
        <button
          type="button"
          className={cx("nav-item activity-item", activeJob && "is-busy")}
          onClick={openActivity}
          data-tip={rail ? (activeJob ? `Transcribing ${activeJob.title}` : "Activity") : undefined}
        >
          {activeJob ? <LoaderCircle size={18} className="spin" aria-hidden /> : <Check size={18} aria-hidden />}
          <span className="nav-label activity-text">
            {activeJob ? (
              <>
                <b>{activeJob.title}</b>
                <small>{activeJob.message || "Processing"}</small>
              </>
            ) : (
              "No activity"
            )}
          </span>
        </button>
        <button
          type="button"
          className={cx("nav-item", settingsActive && "is-active")}
          aria-current={settingsActive ? "page" : undefined}
          data-tip={rail ? "Settings" : undefined}
          onClick={() => navigate({ page: "settings" })}
        >
          <Settings2 size={18} aria-hidden />
          <span className="nav-label">Settings</span>
        </button>
        {canCollapse && (
          <button type="button" className="nav-item collapse-item" onClick={onToggle} data-tip={rail ? "Expand sidebar" : undefined}>
            {rail ? <PanelLeftOpen size={18} aria-hidden /> : <PanelLeftClose size={18} aria-hidden />}
            <span className="nav-label">Collapse</span>
          </button>
        )}
      </div>
    </aside>
  );
}
