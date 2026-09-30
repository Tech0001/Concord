import type { ComponentPropsWithRef, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../lib/cx.ts";

type Base = Omit<ComponentPropsWithRef<"button">, "children">;

export type ButtonProps = Base & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: LucideIcon;
  children?: ReactNode;
};

export function Button({ variant = "secondary", size = "md", icon: Icon, children, className, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={cx("btn", `btn-${variant}`, `btn-${size}`, className)} {...rest}>
      {Icon && <Icon size={size === "sm" ? 14 : 16} aria-hidden />}
      {children}
    </button>
  );
}

export type IconButtonProps = Base & { label: string; icon: LucideIcon; size?: "sm" | "md"; active?: boolean };

export function IconButton({ label, icon: Icon, size = "md", active, className, type = "button", ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      data-tip={label}
      aria-pressed={active}
      className={cx("icon-btn", `icon-btn-${size}`, active && "is-active", className)}
      {...rest}
    >
      <Icon size={size === "sm" ? 15 : 17} aria-hidden />
    </button>
  );
}
