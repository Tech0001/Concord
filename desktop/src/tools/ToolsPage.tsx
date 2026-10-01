import { DiscoverPanel } from "./DiscoverPanel.tsx";
import { AudioLines, Mic, Compass } from "lucide-react";
import { useApp } from "../shell/AppContext.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { useTools } from "./ToolsContext.tsx";
import { ExtractPanel } from "./ExtractPanel.tsx";
import { RecorderPanel } from "./RecorderPanel.tsx";

export function ToolsPage({
  tab = "extract",
  source,
}: {
  tab?: "extract" | "record" | "discover";
  source?: string;
}) {
  const { navigate } = useApp();
  const { state, error } = useTools();
  return (
    <div className="tools-page">
      <PageHeader
        title="Tools"
        meta="Capture, convert, and find recordings for your archive."
      />
      <Segmented
        label="Media tools"
        value={tab}
        onChange={(tab) => navigate({ page: "tools", tab })}
        options={[
          { value: "extract", label: "Extract audio", icon: AudioLines },
          { value: "record", label: "Voice recorder", icon: Mic },
          { value: "discover", label: "Discover", icon: Compass },
        ]}
      />
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
      {!state ? (
        <p className="muted">Loading tools…</p>
      ) : tab === "extract" ? (
        <ExtractPanel source={source} />
      ) : tab === "record" ? (
        <RecorderPanel />
      ) : (
        <DiscoverPanel />
      )}
    </div>
  );
}
