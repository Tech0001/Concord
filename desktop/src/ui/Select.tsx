import * as S from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cx } from "../lib/cx.ts";

const EMPTY = "__none__"; // Radix forbids empty-string item values.

export type Option<T extends string> = { value: T; label: string };

export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  className,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Option<T>[];
  label: string;
  size?: "sm" | "md";
  className?: string;
  disabled?: boolean;
}) {
  return (
    <S.Root disabled={disabled} value={value || EMPTY} onValueChange={(v) => onChange((v === EMPTY ? "" : v) as T)}>
      <S.Trigger className={cx("select", `select-${size}`, className)} aria-label={label}>
        <S.Value />
        <S.Icon className="select-icon">
          <ChevronDown size={14} />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content className="menu select-content" position="popper" sideOffset={6} collisionPadding={8}>
          <S.Viewport>
            {options.map((o) => (
              <S.Item key={o.value || EMPTY} value={o.value || EMPTY} className="menu-item">
                <S.ItemText>{o.label}</S.ItemText>
                <S.ItemIndicator className="menu-check">
                  <Check size={14} />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}
