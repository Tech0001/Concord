import type { CSSProperties, ReactNode } from "react";
import { cx } from "../lib/cx.ts";

export function Chip({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warn" | "danger";
  className?: string;
  title?: string;
}) {
  return (
    <span className={cx("chip", `chip-${tone}`, className)} title={title}>
      {children}
    </span>
  );
}

export function SpeakerChip({
  name,
  color,
  onClick,
  size = "md",
  title,
}: {
  name: string;
  color: string;
  onClick?: () => void;
  size?: "sm" | "md";
  title?: string;
}) {
  const style = { "--speaker": color } as CSSProperties;
  const body = (
    <>
      <i aria-hidden className="speaker-dot" />
      <span className="speaker-chip-name">{name}</span>
    </>
  );
  return onClick ? (
    <button type="button" className={cx("speaker-chip", `speaker-chip-${size}`, "is-button")} style={style} onClick={onClick} title={title}>
      {body}
    </button>
  ) : (
    <span className={cx("speaker-chip", `speaker-chip-${size}`)} style={style} title={title}>
      {body}
    </span>
  );
}
