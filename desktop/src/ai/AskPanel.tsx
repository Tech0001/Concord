import { Expand, X } from "lucide-react";
import { useApp } from "../shell/AppContext.tsx";
import { useChatShell } from "./ChatStore.tsx";
import { ChatView } from "./ChatView.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Sheet } from "../ui/Dialog.tsx";
import { PHONE, useMediaQuery } from "../lib/media-query.ts";
export function AskPanel() {
  const chat = useChatShell();
  const { route, navigate } = useApp();
  const phone = useMediaQuery(PHONE);
  const dismiss = () => {
    chat.close();
    document
      .querySelector<HTMLButtonElement>('button[aria-label="Ask Concord"]')
      ?.focus();
  };
  if (!chat.open || route.page === "ai") return null;
  const expand = () => {
    chat.close();
    navigate({ page: "ai" });
  };
  const controls = (
    <Button size="sm" variant="ghost" icon={Expand} onClick={expand}>
      Full view
    </Button>
  );
  if (phone)
    return (
      <Sheet open onOpenChange={(v) => !v && dismiss()} title="Ask Concord">
        <div className="ask-sheet">
          {controls}
          <ChatView compact />
        </div>
      </Sheet>
    );
  return (
    <aside
      className="ask-panel"
      aria-label="Ask Concord"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          dismiss();
        }
      }}
    >
      <header className="ask-panel-head">
        <strong>Ask Concord</strong>
        {controls}
        <IconButton icon={X} label="Close Ask" onClick={dismiss} />
      </header>
      <ChatView compact />
    </aside>
  );
}
