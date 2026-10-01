import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import { api } from "../lib/ipc.ts";
import type { Route } from "../lib/router.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { checklist, speechPercent, type ChecklistItem } from "./model.ts";
import { Bar, Segments } from "./parts.tsx";
import type { SetupStatus } from "./types.ts";
import "./setup.css";

/** Show the checklist on the Library only after someone went through setup, until it is done or hidden. */
export function checklistOnLibrary(s: SetupStatus): boolean {
  const p = s.progress;
  const started = p.completed || p.furthest !== "library";
  return started && !p.checklistHidden && checklist(s).some((i) => i.state !== "done");
}

export function SetupChecklist({ variant, onNavigate }: { variant: "library" | "health"; onNavigate?: () => void }) {
  const { setup, navigate, refreshSetup, device, refresh, openActivity, category } = useApp();
  const toast = useToast();
  if (!setup || (variant === "library" && !checklistOnLibrary(setup))) return null;
  const items = checklist(setup);
  const done = items.filter((i) => i.state === "done").length;
  const open = (route: Route) => {
    onNavigate?.();
    navigate(route);
  };
  const setupStep = (step: "speech" | "recordings" | "ai") => open({ page: "setup", step, returnTo: "library" });
  const run = (work: () => Promise<unknown>) => () =>
    void work()
      .then(refreshSetup)
      .catch(toast.error);
  const addFiles = run(async () => {
    const paths = await api.pickMedia();
    if (!paths.length) return;
    const n = await api.importAndQueue(paths, category || "personal", device);
    refresh();
    toast.success(n === 1 ? "1 recording added and queued" : `${n} recordings added and queued`);
  });
  const hide = run(() => api.setupSave({ checklistHidden: !setup.progress.checklistHidden }));
  const actions = (item: ChecklistItem) => {
    if (item.state === "done") return null;
    switch (item.id) {
      case "speech":
        if (item.state === "running")
          return (
            <Button
              size="sm"
              onClick={() => {
                onNavigate?.();
                openActivity();
              }}
            >
              Details
            </Button>
          );
        return item.state === "failed" ? (
          <Button size="sm" variant="primary" onClick={run(() => api.speechSetupStart())}>
            {setup.speech.setup.status === "interrupted" ? "Resume" : "Try again"}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setupStep("speech")}>
            Install
          </Button>
        );
      case "recordings":
        return (
          <>
            <Button size="sm" variant="primary" onClick={addFiles}>
              Add files
            </Button>
            <Button size="sm" onClick={() => setupStep("recordings")}>
              More sources
            </Button>
          </>
        );
      case "search":
        return item.state === "running" ? null : (
          <Button size="sm" onClick={() => setupStep("ai")}>
            Set up
          </Button>
        );
      case "chat":
        return (
          <Button size="sm" onClick={() => setupStep("ai")}>
            Connect
          </Button>
        );
      default:
        return null;
    }
  };
  const pct = speechPercent(setup.speech.setup);
  return (
    <section className="setup-checklist" aria-label="Finish setting up">
      <div className="setup-checklist-head">
        <div>
          <span>
            <b>{variant === "health" ? "Setup" : "Finish setting up"}</b>
            <small>
              {done} of {items.length} done
            </small>
          </span>
          <Segments states={items.map((i) => i.state)} />
        </div>
        {variant === "library" && (
          <Button variant="ghost" size="sm" onClick={hide}>
            Hide checklist
          </Button>
        )}
      </div>
      {items.map((item) => (
        <div key={item.id} className="setup-checklist-row" data-state={item.state}>
          <span className="setup-check-dot">
            {item.state === "done" ? (
              <Check size={12} strokeWidth={3} aria-hidden />
            ) : item.state === "running" ? (
              <LoaderCircle size={12} className="spin" aria-hidden />
            ) : item.state === "failed" ? (
              <CircleAlert size={12} aria-hidden />
            ) : null}
          </span>
          <b>{item.title}</b>
          <span className="detail">
            {item.detail}
            {item.id === "speech" && item.state === "running" && <Bar pct={pct} />}
          </span>
          <span className="row-actions">{actions(item)}</span>
        </div>
      ))}
      {variant === "health" && (
        <div className="setup-checklist-foot">
          <button type="button" role="switch" aria-checked={!setup.progress.checklistHidden} className="setup-switch" onClick={hide}>
            <span className="setup-switch-track" />
            Show checklist on Library
          </button>
          <span className="spacer" />
          <Button size="sm" variant="ghost" onClick={() => open({ page: "setup", step: "speech" })}>
            Open setup
          </Button>
        </div>
      )}
    </section>
  );
}
