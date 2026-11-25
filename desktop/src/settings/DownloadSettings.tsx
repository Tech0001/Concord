import { useEffect, useState } from "react";
import {
  Clock,
  Download,
  ExternalLink,
  FolderOpen,
  RefreshCw,
  Save,
} from "lucide-react";
import { api, type DownloaderStatus } from "../lib/ipc.ts";
import type { PipelineConfig } from "../pipeline/types.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Switch } from "../ui/Switch.tsx";
import { useToast } from "../ui/Toasts.tsx";

export function DownloadSettings({
  config,
  onSave,
}: {
  config?: PipelineConfig;
  onSave: (value: PipelineConfig) => Promise<void>;
}) {
  const [status, setStatus] = useState<DownloaderStatus>();
  const [draft, setDraft] = useState<PipelineConfig | undefined>(config);
  const [busyTool, setBusyTool] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (config) setDraft(config);
  }, [config]);

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try {
        const value = await api.downloaderStatus();
        if (alive) setStatus(value);
      } catch (e) {
        if (alive) toast.error(e);
      } finally {
        if (alive) timer = window.setTimeout(poll, 2000);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [toast]);

  const runTool = async (work: () => Promise<void>) => {
    setBusyTool(true);
    try {
      await work();
      setStatus(await api.downloaderStatus());
    } catch (e) {
      toast.error(e);
    } finally {
      setBusyTool(false);
    }
  };

  const setField = <K extends keyof PipelineConfig>(
    key: K,
    val: PipelineConfig[K],
  ) => setDraft((prev) => (prev ? { ...prev, [key]: val } : prev));

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await onSave(draft);
      toast.success("Download & schedule settings saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    try {
      const path = await api.pickFolder("Choose where recordings are downloaded");
      if (path) setField("downloadDirectory", path);
    } catch (e) {
      toast.error(e);
    }
  };

  const pickCookies = async () => {
    try {
      const paths = await api.pickFiles({
        title: "Choose a Netscape cookies.txt file",
        name: "Cookies",
        extensions: ["txt"],
        multiple: false,
      });
      if (paths[0]) setField("cookiesFile", paths[0]);
    } catch (e) {
      toast.error(e);
    }
  };

  const install = status?.install;
  const toggleDownloader = (enabled: boolean) =>
    runTool(() =>
      enabled && !status?.installed
        ? api.downloaderInstall()
        : api.downloaderEnable(enabled),
    );

  const dirty =
    !!config &&
    !!draft &&
    JSON.stringify({ ...draft, device: config.device, speechLanguage: config.speechLanguage, transcriptDirectory: config.transcriptDirectory }) !==
      JSON.stringify(config);

  return (
    <>
      <section className="settings-section">
        <header>
          <span className="settings-icon">
            <Download size={17} aria-hidden />
          </span>
          <h2>YouTube &amp; link downloads</h2>
        </header>
        <div className="settings-body">
          <Switch
            checked={status?.enabled ?? false}
            disabled={!status || busyTool || (!!install?.running && !status.enabled)}
            onChange={(checked) => void toggleDownloader(checked)}
            hint={
              !status
                ? "Checking downloader status…"
                : status.installed
                  ? `Managed yt-dlp ${status.version} installed${status.enabled ? "" : " · disabled"}. Updates only when you ask.`
                  : "Off by default. Enabling installs managed yt-dlp from its official GitHub release with checksum verification."
            }
          >
            Enable YouTube downloads
          </Switch>

          {install?.running && (
            <div role="status" className="settings-install-box">
              <p>{install.message}</p>
              {!!install.total && (
                <>
                  <progress
                    aria-label="yt-dlp download"
                    value={install.done}
                    max={install.total}
                  />
                  <small className="muted">
                    {(install.done / 1e6).toFixed(1)} /{" "}
                    {(install.total / 1e6).toFixed(1)} MB
                  </small>
                </>
              )}
            </div>
          )}
          {install?.error && (
            <p role="alert" className="is-error">
              {install.error}
            </p>
          )}
          {!install?.running && !install?.error && install?.message && (
            <p role="status" className="settings-note">
              {install.message}
            </p>
          )}

          <div className="tool-actions">
            {status?.enabled && (
              <Button
                size="sm"
                icon={status.installed ? RefreshCw : Download}
                disabled={busyTool || install?.running}
                onClick={() => void runTool(api.downloaderInstall)}
              >
                {status.installed
                  ? "Check & install update"
                  : "Retry installation"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={ExternalLink}
              onClick={() =>
                void api
                  .openExternal("https://github.com/yt-dlp/yt-dlp")
                  .catch(toast.error)
              }
            >
              Official yt-dlp repository
            </Button>
          </div>

          {draft && (
            <div className="settings-divider-block">
              <label className="field">
                <span>Save downloaded videos in · a folder for each channel</span>
                <div className="pipeline-path">
                  <input
                    className="input"
                    aria-label="Download folder"
                    placeholder="Not chosen yet · Concord’s own media folder"
                    value={draft.downloadDirectory}
                    onChange={(e) =>
                      setField("downloadDirectory", e.target.value)
                    }
                  />
                  <Button icon={FolderOpen} onClick={() => void pickFolder()}>
                    Browse
                  </Button>
                </div>
              </label>

              <div className="settings-grid-2">
                <label className="field">
                  <span>Quality preference</span>
                  <Select
                    label="Download quality"
                    value={draft.quality}
                    onChange={(v) => setField("quality", v)}
                    options={["best", "2160", "1440", "1080", "720", "480", "360"].map(
                      (v) => ({
                        value: v,
                        label: v === "best" ? "Best available" : `${v}p`,
                      }),
                    )}
                  />
                </label>
                <label className="field">
                  <span>Video codec</span>
                  <Select
                    label="Video codec"
                    value={draft.codec}
                    onChange={(v) => setField("codec", v)}
                    options={[
                      { value: "any", label: "Best available codec" },
                      { value: "avc1", label: "Prefer H.264 · compatibility" },
                      { value: "av01", label: "Prefer AV1 · smaller files" },
                      { value: "vp9", label: "Prefer VP9" },
                    ]}
                  />
                </label>
                <label className="field">
                  <span>Preferred audio language</span>
                  <input
                    className="input"
                    aria-label="Download audio language"
                    placeholder="en"
                    value={draft.audioLanguage}
                    onChange={(e) => setField("audioLanguage", e.target.value)}
                  />
                </label>
                <div className="settings-switch-cell">
                  <Switch
                    checked={draft.audioOnly}
                    onChange={(v) => setField("audioOnly", v)}
                  >
                    Download audio only
                  </Switch>
                </div>
              </div>

              <details className="settings-disclosure">
                <summary>YouTube sign-in (optional cookies)</summary>
                <div className="settings-disclosure-body">
                  <p className="settings-note">
                    Optional. Use browser cookies if YouTube asks you to sign
                    in. A cookies file takes precedence over a browser choice.
                  </p>
                  <label className="field">
                    <span>Cookies file</span>
                    <div className="pipeline-path">
                      <input
                        className="input"
                        aria-label="YouTube cookies file"
                        value={draft.cookiesFile}
                        onChange={(e) => setField("cookiesFile", e.target.value)}
                        placeholder="Optional cookies.txt path"
                      />
                      <Button onClick={() => void pickCookies()}>Browse</Button>
                    </div>
                  </label>
                  <label className="field">
                    <span>Or use cookies from</span>
                    <Select
                      label="YouTube cookies browser"
                      value={draft.cookiesBrowser}
                      onChange={(v) => setField("cookiesBrowser", v)}
                      options={[
                        { value: "", label: "No browser cookies" },
                        ...[
                          "firefox",
                          "chrome",
                          "chromium",
                          "brave",
                          "edge",
                          "vivaldi",
                        ].map((v) => ({
                          value: v,
                          label: v[0].toUpperCase() + v.slice(1),
                        })),
                      ]}
                    />
                  </label>
                </div>
              </details>
            </div>
          )}

          <small className="muted">
            Only download content you are permitted to download under the
            service’s terms and applicable law.
          </small>
        </div>
      </section>

      {draft && (
        <section className="settings-section">
          <header>
            <span className="settings-icon">
              <Clock size={17} aria-hidden />
            </span>
            <h2>Schedule, limits &amp; retries</h2>
          </header>
          <div className="settings-body">
            <div className="settings-grid-2">
              <label className="field">
                <span>Check followed channels &amp; folders every (minutes)</span>
                <input
                  className="input"
                  type="number"
                  min={5}
                  max={10080}
                  value={draft.checkMinutes}
                  onChange={(e) =>
                    setField("checkMinutes", Number(e.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>Downloads per day</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={10000}
                  value={draft.dailyLimit}
                  onChange={(e) =>
                    setField("dailyLimit", Number(e.target.value))
                  }
                />
              </label>
              <label className="field">
                <span>Download pace</span>
                <Select
                  label="Download pace"
                  value={draft.speed}
                  onChange={(v) => setField("speed", v)}
                  options={[
                    {
                      value: "conservative",
                      label: "Conservative · 5–10s pauses",
                    },
                    { value: "balanced", label: "Balanced · 2–5s pauses" },
                    { value: "fast", label: "Fast · no added pauses" },
                  ]}
                />
              </label>
              <label className="field">
                <span>Rate limit (MiB/s · 0 = unlimited)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={1000}
                  value={draft.rateMib}
                  onChange={(e) => setField("rateMib", Number(e.target.value))}
                />
              </label>
            </div>

            <Switch
              checked={draft.automaticChecks}
              onChange={(v) => setField("automaticChecks", v)}
              hint="Checks imported older subscriptions too, adding every video they list instead of only newly posted ones."
            >
              Also check older subscriptions
            </Switch>

            <div className="settings-divider-block">
              <div className="settings-grid-2">
                <label className="field">
                  <span>Automatic retries on failure</span>
                  <input
                    className="input"
                    aria-label="Automatic retries"
                    type="number"
                    min={0}
                    max={10}
                    value={draft.retries}
                    onChange={(e) =>
                      setField("retries", Number(e.target.value))
                    }
                  />
                </label>
                <label className="field">
                  <span>Minutes between retries</span>
                  <input
                    className="input"
                    aria-label="Minutes between retries"
                    type="number"
                    min={1}
                    max={1440}
                    value={draft.retryMinutes}
                    onChange={(e) =>
                      setField("retryMinutes", Number(e.target.value))
                    }
                  />
                </label>
              </div>
              <small className="muted">
                Retry delays survive restarting Concord. Daily download limits
                reset at local midnight; local recordings continue transcribing
                normally.
              </small>
            </div>

            <div>
              <Button
                variant={dirty ? "primary" : "secondary"}
                icon={Save}
                disabled={saving || !dirty}
                onClick={() => void save()}
              >
                Save download &amp; schedule settings
              </Button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
