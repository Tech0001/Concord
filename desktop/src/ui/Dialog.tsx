import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "../lib/cx.ts";
import { Button, IconButton } from "./Button.tsx";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "center" | "side" | "sheet";
  children?: ReactNode;
};

export function Dialog({ open, onOpenChange, title, description, footer, size = "md", variant = "center", children }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="overlay" />
        {/* Radix expects aria-describedby={undefined} when there is no description. */}
        <D.Content className={cx("dialog", `dialog-${variant}`, `dialog-${size}`)} aria-describedby={undefined}>
          <header className="dialog-head">
            <D.Title className="dialog-title">{title}</D.Title>
            <D.Close asChild>
              <IconButton label="Close" icon={X} size="sm" />
            </D.Close>
          </header>
          {description && <D.Description className="dialog-desc">{description}</D.Description>}
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

export const Sheet = (props: Omit<DialogProps, "variant">) => <Dialog {...props} variant="sheet" />;

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="dialog-text">{body}</div>
    </Dialog>
  );
}
