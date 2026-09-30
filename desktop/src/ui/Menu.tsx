import * as Popover from "@radix-ui/react-popover";
import { Check, type LucideIcon } from "lucide-react";
import { cloneElement, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { PHONE, useMediaQuery } from "../lib/media-query.ts";
import { Sheet } from "./Dialog.tsx";

export type MenuEntry =
  | {
      kind?: "item";
      label: string;
      icon?: LucideIcon;
      onSelect: () => void;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      hint?: string;
    }
  | { kind: "separator" }
  | { kind: "label"; label: string };

type Trigger = ReactElement<{ onClick?: () => void }>;

export function Menu({ trigger, entries, label, align = "end" }: { trigger: Trigger; entries: MenuEntry[]; label: string; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const phone = useMediaQuery(PHONE);
  const content = useRef<HTMLDivElement>(null);
  const list = <MenuList entries={entries} onDone={() => setOpen(false)} />;
  if (phone)
    return (
      <>
        {cloneElement(trigger, { onClick: () => setOpen(true) })}
        <Sheet open={open} onOpenChange={setOpen} title={label}>
          {list}
        </Sheet>
      </>
    );
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          ref={content}
          className="menu"
          align={align}
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            content.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
          }}
        >
          {list}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MenuList({ entries, onDone }: { entries: MenuEntry[]; onDone: () => void }) {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div role="menu" className="menu-list" onKeyDown={onKeyDown}>
      {entries.map((entry, i) =>
        entry.kind === "separator" ? (
          <div key={i} role="separator" className="menu-sep" />
        ) : entry.kind === "label" ? (
          <div key={i} className="menu-label">
            {entry.label}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            className={cx("menu-item", entry.danger && "is-danger")}
            onClick={() => {
              onDone();
              entry.onSelect();
            }}
          >
            {entry.icon ? <entry.icon size={15} aria-hidden /> : <span className="menu-icon-space" />}
            <span className="menu-item-label">{entry.label}</span>
            {entry.checked && <Check size={14} className="menu-check" aria-hidden />}
            {entry.hint && <kbd className="kbd">{entry.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

/** A popover panel on desktop and a bottom sheet on phones (used for filter panels). */
export function Panel({
  trigger,
  title,
  children,
  align = "end",
  open,
  onOpenChange,
}: {
  trigger: Trigger;
  title: string;
  children: ReactNode;
  align?: "start" | "end";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const phone = useMediaQuery(PHONE);
  if (phone)
    return (
      <>
        {cloneElement(trigger, { onClick: () => onOpenChange(true) })}
        <Sheet open={open} onOpenChange={onOpenChange} title={title}>
          {children}
        </Sheet>
      </>
    );
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="menu panel" align={align} sideOffset={6} collisionPadding={8} aria-label={title}>
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
