import { useState } from "react";
import { FolderOpen, Plus } from "lucide-react";
import icon from "../../../assets/brand/concord-icon.svg";
import { api } from "../lib/ipc.ts";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";

export function Welcome() {
  const { importLegacy, refresh } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try { await api.startLibrary(); refresh(); }
    catch (e) { toast.error(e); }
    finally { setBusy(false); }
  };
  return (
    <section className="welcome">
      <img src={icon} alt="" width={56} height={56} />
      <h1>Start your Concord library</h1>
      <p>A place for your recordings, documents, and research. Start fresh and add what matters to you.</p>
      <div className="welcome-actions">
        <Button variant="primary" icon={Plus} disabled={busy} onClick={() => void start()}>
          {busy ? "Starting…" : "Start a new library"}
        </Button>
      </div>
      <div className="welcome-import">
        <h2>Already have a Concord library?</h2>
        <p>Bring over your recordings, speaker profiles, and notes.</p>
        <Button icon={FolderOpen} disabled={busy} onClick={() => void importLegacy()}>
          Import existing library…
        </Button>
      </div>
    </section>
  );
}
