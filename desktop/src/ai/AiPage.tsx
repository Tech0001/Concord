import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { ChatView } from "./ChatView.tsx";
import { useChat } from "./ChatStore.tsx";
import { IndexControl } from "./IndexControl.tsx";
import { SearchPanel } from "./SearchPanel.tsx";
import { PENDING_HELP } from "./help-links.ts";
import "./ai.css";
export function AiPage() {
  const { navigate, route } = useApp();
  const chat = useChat();
  const [tab, setTab] = useState<"chat" | "semantic">("chat");
  const intent = route.page === "ai" ? route : undefined;
  useEffect(() => {
    if (chat.open) {
      setTab("chat");
      chat.close();
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLTextAreaElement>(".chat-composer textarea")
          ?.focus(),
      );
    }
  }, [chat.open]);
  useEffect(() => {
    const question =
      intent?.question || sessionStorage.getItem(PENDING_HELP) || undefined;
    if (intent?.context || question) {
      chat.changeContext(
        intent?.context ?? "help",
        chat.recordingId,
        chat.recordingTitle,
        question,
      );
      setTab("chat");
      sessionStorage.removeItem(PENDING_HELP);
      navigate({ page: "ai" }, { replace: true });
    }
    chat.close();
  }, [intent?.context, intent?.question]);
  return (
    <div className={`ai-page ${tab === "chat" ? "has-chat" : ""}`}>
      <PageHeader
        title="AI"
        actions={
          <Button
            icon={Settings2}
            onClick={() => navigate({ page: "settings", section: "ai" })}
          >
            AI settings
          </Button>
        }
      />
      <div className="ai-tabs" role="tablist" aria-label="AI tools">
        <button
          role="tab"
          aria-selected={tab === "chat"}
          onClick={() => setTab("chat")}
        >
          Chat
        </button>
        <button
          role="tab"
          aria-selected={tab === "semantic"}
          onClick={() => setTab("semantic")}
        >
          Semantic search
        </button>
      </div>
      {tab === "chat" ? (
        <ChatView />
      ) : (
        <>
          <IndexControl />
          <SearchPanel semantic />
        </>
      )}
    </div>
  );
}
