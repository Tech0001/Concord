import { useEffect } from "react";
import { Settings2, Sparkles } from "lucide-react";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { ChatView } from "./ChatView.tsx";
import { useChat } from "./ChatStore.tsx";
import { PENDING_HELP } from "./help-links.ts";
import "./ai.css";

export function AiPage() {
  const { navigate, route } = useApp();
  const chat = useChat();
  const intent = route.page === "ai" ? route : undefined;

  useEffect(() => {
    if (chat.open) {
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
      sessionStorage.removeItem(PENDING_HELP);
      navigate({ page: "ai" }, { replace: true });
    }
    chat.close();
  }, [intent?.context, intent?.question]);

  return (
    <div className="ai-page has-chat">
      <PageHeader
        title="AI"
        actions={
          <>
            <Button
              variant="ghost"
              icon={Sparkles}
              onClick={() => navigate({ page: "search", q: "", mode: "meaning" })}
            >
              Search by meaning
            </Button>
            <Button
              icon={Settings2}
              onClick={() => navigate({ page: "settings", section: "ai" })}
            >
              AI settings
            </Button>
          </>
        }
      />
      <ChatView />
    </div>
  );
}
