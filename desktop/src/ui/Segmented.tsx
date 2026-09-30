import type { LucideIcon } from "lucide-react";
import { cx } from "../lib/cx.ts";

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: LucideIcon; iconOnly?: boolean }[];
  label: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("segmented", `segmented-${size}`)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          aria-label={o.iconOnly ? o.label : undefined}
          data-tip={o.iconOnly ? o.label : undefined}
          className={cx("segment", value === o.value && "is-on")}
          onClick={() => onChange(o.value)}
        >
          {o.icon && <o.icon size={15} aria-hidden />}
          {!o.iconOnly && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
