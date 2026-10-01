import { useEffect, useState } from "react";
import { Compass, ExternalLink, KeyRound } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";

export function YouTubeSettings() {
  const [configured, setConfigured] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    void api
      .youtubeStatus()
      .then((s) => setConfigured(s.hasKey))
      .catch(toast.error);
  }, [toast]);
  const save = async (value: string) => {
    setBusy(true);
    try {
      setConfigured((await api.youtubeSaveKey(value)).hasKey);
      setKey("");
      toast.success(
        value ? "YouTube search key saved" : "YouTube search key removed",
      );
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="settings-section">
      <header>
        <span className="settings-icon">
          <Compass size={17} />
        </span>
        <h2>YouTube Discover</h2>
      </header>
      <div className="settings-body youtube-settings">
        <p>
          Search YouTube from Tools → Discover. Queries are sent to Google using
          your YouTube Data API v3 key. Subscriptions and downloads use their
          own setup in Pipeline.
        </p>
        <label className="field">
          YouTube Data API key
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-label="YouTube Data API key"
            placeholder={
              configured
                ? "Key saved · enter a replacement"
                : "Enter a YouTube Data API v3 key"
            }
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="tool-actions">
          <Button
            icon={KeyRound}
            variant="primary"
            disabled={busy || !key.trim()}
            onClick={() => void save(key.trim())}
          >
            Save key
          </Button>
          {configured && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void save("")}
            >
              Remove key
            </Button>
          )}
          <Button
            icon={ExternalLink}
            onClick={() =>
              void api
                .openExternal(
                  "https://console.cloud.google.com/apis/library/youtube.googleapis.com",
                )
                .catch(toast.error)
            }
          >
            Google API setup
          </Button>
        </div>
        <small className="muted">
          Stored privately on this computer and included in database backups.
          The saved key is never displayed.
        </small>
      </div>
    </section>
  );
}
