import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";

/** An on/off control with its label. `hint` is a second, quieter line. */
export function Switch({ checked, onChange, children, hint, disabled, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} className={cx("switch", hint != null && "switch-hinted", className)} onClick={() => onChange(!checked)}>
      <span className="switch-track" aria-hidden />
      {hint == null ? children : <span className="switch-text"><span className="switch-label">{children}</span><span className="switch-hint">{hint}</span></span>}
    </button>
  );
}
