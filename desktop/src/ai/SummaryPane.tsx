import { useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { Markdown } from "../documents/Markdown.tsx";
import { chatReady, type AiConfig, type Summary } from "./types.ts";
import "./ai.css";
export function SummaryPane({ id, title }: { id: string; title: string }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [config, setConfig] = useState<AiConfig>();
  const [busy, setBusy] = useState(false);
  const { navigate, openNote } = useApp();
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    Promise.all([api.aiSummary(id), api.aiConfig()])
      .then(([s, c]) => {
        if (alive) {
          setSummary(s);
          setConfig(c);
        }
      })
      .catch(toast.error);
    return () => {
      alive = false;
    };
  }, [id, toast]);
  const generate = async () => {
    setBusy(true);
    try {
      setSummary(await api.aiSummary(id, true));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="summary-pane">
      {summary ? (
        <>
          <Markdown source={summary.content} />
          <p className="muted">Generated with {summary.model}</p>
          <Button
            size="sm"
            onClick={() =>
              openNote({
                title: `${title} · Summary`,
                body: summary.content,
                media_id: id,
                start: 0,
              })
            }
          >
            Save as note
          </Button>
        </>
      ) : (
        <Empty
          icon={FileText}
          title="Recording summary"
          text="Summarize the full transcript with your chosen chat model. Long recordings are summarized in sections."
        />
      )}
      {chatReady(config?.chat) ? (
        <>
          <p className="muted">
            {config?.chat.local
              ? "Uses the chat model on this computer."
              : "Sends transcript text to your chat provider. Long recordings require multiple requests."}
          </p>
          <Button
            icon={RefreshCw}
            disabled={busy}
            onClick={() => void generate()}
          >
            {busy
              ? "Summarizing transcript…"
              : summary
                ? "Regenerate summary"
                : "Generate summary"}
          </Button>
        </>
      ) : (
        <Button onClick={() => navigate({ page: "settings" })}>
          Set up chat in Settings
        </Button>
      )}
    </div>
  );
}
