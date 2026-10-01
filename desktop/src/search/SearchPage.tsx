import { useState } from "react";
import { Sparkles } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { useStoredState } from "../lib/storage.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { SearchPanel } from "../ai/SearchPanel.tsx";
import "../setup/setup.css";
import "./search.css";

/** Exact matches only until Smart search is set up; say so once, with a way to turn it on. */
function SmartSearchHint() {
  const { setup, navigate, openActivity } = useApp();
  const toast = useToast();
  const [dismissed, setDismissed] = useStoredState("smart-search-hint-dismissed-v1", false, (v) => typeof v === "boolean");
  const [starting, setStarting] = useState(false);
  const [started, setStarted] = useState(false);
  if (!setup || dismissed || setup.search.modelReady) return null;
  const builtin = setup.search.enabled && setup.search.kind === "builtin";
  const downloading = started || ["waiting", "running"].includes(setup.search.download.status);
  const turnOn = async () => {
    if (!builtin) return navigate({ page: "setup", step: "ai", returnTo: "search" });
    setStarting(true);
    try {
      // Indexing downloads the model first, then indexes the library.
      await api.aiIndex();
      setStarted(true);
      toast.info("Smart search is getting ready", { label: "Status & Health", run: openActivity });
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  return (
    <div className="setup-hint" role="note">
      <Sparkles size={18} aria-hidden />
      <div>
        {downloading ? (
          <span>Smart search is getting ready. It downloads its model, then indexes your library. You can keep searching meanwhile.</span>
        ) : (
          <>
            <span>Showing exact matches only. Smart search also finds passages that say it differently.</span>
            <span className="setup-actions">
              <Button size="sm" variant="primary" disabled={starting} onClick={() => void turnOn()}>
                {builtin ? "Turn on · 639 MB, on this computer" : "Set up Smart search"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
                Not now
              </Button>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export function SearchPage({ q }: { q: string }) {
  return (
    <div className="search-page">
      <PageHeader title="Search" />
      <SmartSearchHint />
      <SearchPanel semantic={false} q={q} />
    </div>
  );
}
