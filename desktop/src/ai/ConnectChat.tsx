import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useApp } from "../shell/AppContext.tsx";
import { useChat } from "./ChatStore.tsx";
import { Button } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import type { ChatChoice, LocalServer } from "../setup/types.ts";
/** Chat isn't connected: offer the common ways to connect, each opening that part of setup. */
export function ConnectChat() {
  const { navigate } = useApp();
  const { close } = useChat();
  const [servers, setServers] = useState<LocalServer[]>([]);
  useEffect(() => {
    api
      .setupProbeLocal()
      .then(setServers)
      .catch(() => setServers([]));
  }, []);
  const go = (chat: ChatChoice) => {
    close();
    navigate({ page: "setup", step: "ai", returnTo: "ai", chat });
  };
  const server = servers[0];
  return (
    <Empty
      icon={MessageCircle}
      title="Connect chat"
      text="Ask about your recordings, get help setting up Concord, or have a general conversation. Choose what to share with each message."
      action={
        <div className="setup-connect-options">
          <Button onClick={() => go("codex")}>
            Use Codex<small>ChatGPT subscription</small>
          </Button>
          <Button onClick={() => go("claude-code")}>
            Use Claude Code<small>Claude subscription</small>
          </Button>
          <Button onClick={() => go("chatgpt")}>
            Sign in with ChatGPT<small>Uses your plan</small>
          </Button>
          <Button onClick={() => go("openrouter")}>
            Use an OpenRouter key<small>Many models</small>
          </Button>
          <Button onClick={() => go("local")}>
            Use a local server
            {server ? (
              <span className="setup-badge is-ok">
                {server.kind === "lmstudio" ? "LM Studio" : "Ollama"} found
              </span>
            ) : (
              <small>Ollama or LM Studio</small>
            )}
          </Button>
          <button
            type="button"
            className="text-link"
            onClick={() => {
              close();
              navigate({ page: "settings", section: "ai" });
            }}
          >
            More options in Settings › AI
          </button>
        </div>
      }
    />
  );
}
