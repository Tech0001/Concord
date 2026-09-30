import { FolderOpen, Plus } from "lucide-react";
import icon from "../../../assets/brand/concord-icon.svg";
import { Button } from "../ui/Button.tsx";
import { useApp } from "../shell/AppContext.tsx";

export function Welcome() {
  const { overview, importLegacy, addRecordings } = useApp();
  return (
    <section className="welcome">
      <img src={icon} alt="" width={56} height={56} />
      <h1>Bring your archive along</h1>
      <p>Import your Concord library with its speakers and notes, or start with a single recording. Your original app and files stay as they are.</p>
      <div className="welcome-actions">
        <Button variant="primary" icon={FolderOpen} onClick={() => void importLegacy(overview?.legacyDatabase)}>
          Import Concord library
        </Button>
        <Button onClick={() => void importLegacy()}>Choose database…</Button>
        <Button variant="ghost" icon={Plus} onClick={() => void addRecordings()}>
          Add a recording
        </Button>
      </div>
    </section>
  );
}
