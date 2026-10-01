import { Copy, Square, AudioLines } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { copyText } from "../lib/clipboard.ts";
import { clock } from "../lib/format.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useTools } from "./ToolsContext.tsx";
import type { PreviewPassage } from "./types.ts";

export function PreviewText({ passages }: { passages: PreviewPassage[] }) {
  return <div className="voice-preview-text">{passages.map((p, i) => <p key={`${p.start}:${i}`}><time className="mono muted">{clock(p.start)}</time> {p.text}</p>)}</div>;
}
export function LiveTranscript() {
  const { state, reload } = useTools();
  const { device, navigate } = useApp();
  const toast = useToast();
  const active = state?.recorder.active;
  const current = state?.liveTranscript;
  const live = active && current?.id !== active.id ? undefined : current;
  const start = async () => { if (active) { await api.recorderLiveStart(active.id, device); await reload(); } };
  if (!active && !live?.id) return null;
  return <section className="tool-panel voice-preview" aria-label="Live transcript preview">
    <div className="tool-heading"><AudioLines size={22}/><div><h2>Live transcript preview</h2><p>Local speech recognition in short sections. Wording near section boundaries may change in the final transcript.</p></div></div>
    <div className="tool-actions">
      {live?.running ? <Button size="sm" icon={Square} onClick={() => void api.recorderLiveStop().then(reload).catch(toast.error)}>Stop preview</Button> : active && <Button size="sm" onClick={() => void start().catch(toast.error)}>Start live preview</Button>}
      {!!live?.passages.length && <Button size="sm" icon={Copy} onClick={() => void copyText(live.passages.map(p => `[${clock(p.start)}] ${p.text}`).join("\n")).then(() => toast.success("Preview copied")).catch(toast.error)}>Copy preview</Button>}
      {live?.id && <small>{clock(live.processedSeconds)} transcribed{live.device && ` · ${live.device === "cpu" ? "CPU" : "GPU"}`}{live.running && live.lagSeconds >= 15 && ` · ${clock(live.lagSeconds)} waiting`}</small>}
    </div>
    {live?.id && <p role="status" className="muted">{live.message}</p>}
    {live?.running && <p className="muted">Archive processing waits while the preview uses the speech models. Audio capture continues independently.</p>}
    {live?.error && <div role="alert"><p className="field-error">{live.error}</p><Button size="sm" onClick={() => navigate({page:"settings"})}>Speech settings</Button></div>}
    {live && <PreviewText passages={live.passages}/>}
    {live?.id && !live.passages.length && <p className="muted">No speech recognized yet.</p>}
    <small className="muted">Showing the latest 30 sections. Save &amp; transcribe produces the full transcript and speaker labels.</small>
  </section>;
}
