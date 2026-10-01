import { useEffect, useState } from "react";
import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { api, type DownloaderStatus } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";

export function DownloadSettings() {
  const [status, setStatus] = useState<DownloaderStatus>();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    let timer = 0;
    const poll = async () => {
      try { const value = await api.downloaderStatus(); if (alive) setStatus(value); }
      catch (e) { if (alive) toast.error(e); }
      finally { if (alive) timer = window.setTimeout(poll, 1500); }
    };
    void poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [toast]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try { await work(); setStatus(await api.downloaderStatus()); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  const install = status?.install;
  const toggle = (enabled: boolean) => run(() => enabled && !status?.installed ? api.downloaderInstall() : api.downloaderEnable(enabled));
  return <section className="settings-section">
    <header><span className="settings-icon"><Download size={17}/></span><h2>YouTube downloads</h2></header>
    <div className="settings-body youtube-settings">
      <label className="pipeline-checkbox">
        <input type="checkbox" role="switch" aria-label="YouTube downloads" checked={status?.enabled ?? false}
          disabled={!status || busy || (!!install?.running && !status.enabled)} onChange={e => void toggle(e.target.checked)}/>
        Enable YouTube downloads
      </label>
      <p>Off by default. Enabling installs the latest stable yt-dlp from its official GitHub repository and verifies its checksum. Concord keeps its own copy; your system tools stay as they are.</p>
      <p>{!status ? "Checking…" : status.installed ? `yt-dlp ${status.version} installed${status.enabled ? "" : " · disabled"}.` : "yt-dlp is not installed for this library."} Updates only run when you request them.</p>
      {install?.running && <div role="status">
        <p>{install.message}</p>
        {!!install.total && <><progress aria-label="yt-dlp download" value={install.done} max={install.total}/><p>{(install.done / 1e6).toFixed(1)} / {(install.total / 1e6).toFixed(1)} MB</p></>}
        <small>Turn downloads off to stop installation. Completed files and the previous working copy are kept.</small>
      </div>}
      {install?.error && <p role="alert">{install.error}</p>}
      {!install?.running && !install?.error && install?.message && <p role="status">{install.message}</p>}
      <div className="tool-actions">
        {status?.enabled && <Button icon={status.installed ? RefreshCw : Download} disabled={busy || install?.running} onClick={() => void run(api.downloaderInstall)}>
          {status.installed ? "Check & install update" : "Retry installation"}
        </Button>}
        <Button icon={ExternalLink} onClick={() => void api.openExternal("https://github.com/yt-dlp/yt-dlp").catch(toast.error)}>Official yt-dlp repository</Button>
      </div>
      <small className="muted">Turning this off stops downloads and channel checks. Existing recordings remain available. Only download content you are permitted to download under the service’s terms and applicable law.</small>
    </div>
  </section>;
}
