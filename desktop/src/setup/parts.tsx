import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, Check, CircleAlert, Clock3, LoaderCircle, Minus } from "lucide-react";
import { cx } from "../lib/cx.ts";
import { Button } from "../ui/Button.tsx";
import type { ChecklistItem, StepState } from "./model.ts";

export function SetupHead({ eyebrow, accent, title, children }: { eyebrow: string; accent?: boolean; title: string; children?: ReactNode }) {
  return (
    <header className="setup-head">
      <div className={cx("setup-eyebrow", accent && "is-accent")}>{eyebrow}</div>
      <h1 className="setup-title">{title}</h1>
      {children && <p className="setup-lede">{children}</p>}
    </header>
  );
}

export type FootProps = {
  back?: (() => void) | null;
  skip?: (() => void) | null;
  primary?: { label: string; onClick: () => void; disabled?: boolean; icon?: typeof ArrowRight; busy?: boolean };
  note?: ReactNode;
};
export function SetupFoot({ back, skip, primary, note }: FootProps) {
  return (
    <footer className="setup-foot">
      {back && (
        <Button variant="ghost" className="is-back" onClick={back}>
          Back
        </Button>
      )}
      {note && <span className="setup-foot-note">{note}</span>}
      <span className="spacer" />
      {skip && (
        <Button variant="ghost" onClick={skip}>
          Skip for now
        </Button>
      )}
      {primary && (
        <Button variant="primary" className="is-primary" icon={primary.busy ? LoaderCircle : primary.icon} disabled={primary.disabled || primary.busy} onClick={primary.onClick}>
          {primary.label}
          {!primary.icon && !primary.busy && <ArrowRight size={16} aria-hidden />}
        </Button>
      )}
    </footer>
  );
}

/** A progress bar; `pct` null shows ongoing work without a known size. */
export function Bar({ pct, thin }: { pct: number | null; thin?: boolean }) {
  return (
    <span
      className={cx("setup-bar", pct == null && "is-indeterminate", thin && "is-thin")}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      style={pct == null ? undefined : ({ "--pct": `${pct}%` } as CSSProperties)}
    >
      <span />
    </span>
  );
}

export function StateIcon({ state, size = 18 }: { state: StepState | ChecklistItem["state"]; size?: number }) {
  const Icon = state === "done" ? Check : state === "running" ? LoaderCircle : state === "failed" ? CircleAlert : state === "skipped" ? Minus : Clock3;
  return (
    <span className="setup-state-icon" data-state={state}>
      <Icon size={size} className={state === "running" ? "spin" : undefined} aria-hidden />
    </span>
  );
}

/** The five-part progress strip used on narrow windows and the Library checklist. */
export function Segments({ states }: { states: string[] }) {
  return (
    <div className="setup-segments" aria-hidden>
      {states.map((s, i) => (
        <span key={i} data-state={s} />
      ))}
    </div>
  );
}

/** Show a path with the home folder as ~. */
export function tildify(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+/, "~");
}
