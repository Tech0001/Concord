import { LiveTranscript, PreviewText } from "./LiveTranscript.tsx";
import { useEffect, useState } from "react";
import { Mic, Square, Play, Trash2, Save, RefreshCw } from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock } from "../lib/format.ts";
import { useApp } from "../shell/AppContext.tsx";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useTools } from "./ToolsContext.tsx";
import type { VoiceSession } from "./types.ts";

const categories = [
  { value: "personal", label: "Personal" },
  { value: "work", label: "Work" },
];
export function RecorderPanel() {
  const { state, reload } = useTools();
  const { category, device } = useApp();
  const [liveWanted, setLiveWanted] = useState(false);
  const toast = useToast();
  const [inputs, setInputs] = useState([
    { id: "default", name: "System default microphone" },
  ]);
  const [warning, setWarning] = useState("");
  const [input, setInput] = useState("default");
  const [title, setTitle] = useState(
    () => `Voice note · ${new Date().toLocaleString()}`,
  );
  const [scope, setScope] = useState<string>(category || "personal");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ id: string; url: string }>();
  const [lastSaved, setLastSaved] = useState<{ id: string; title: string }>();
  const { navigate } = useApp();
  const loadInputs = async () => {
    try {
      const data = await api.recorderInputs();
      setInputs(data.inputs);
      setWarning(data.warning);
    } catch (e) {
      setWarning(String(e));
    }
  };
  useEffect(() => {
    void loadInputs();
  }, []);
  const active = state!.recorder.active;
  const start = async () => {
    setBusy(true);
    setPreview(undefined);
    try {
      const id = await api.recorderStart(input, title, scope);
      if (liveWanted) { try { await api.recorderLiveStart(id, device); } catch(e) { toast.error(e); } }
      await reload();
      setLastSaved(undefined);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      await api.recorderStop();
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <section className="tool-panel" aria-label="Voice recorder">
        <div className="tool-heading">
          <Mic size={22} />
          <div>
            <h2>Capture a voice note</h2>
            <p>
              Audio stays on this computer. Recording continues when you change
              pages.
            </p>
          </div>
        </div>
        {active ? (
          <div className="recorder-live">
            <span className="recording-dot" />
            <strong className="num recorder-clock">
              {clock(active.seconds)}
            </strong>
            <span>
              {active.stopping ? "Finishing recording…" : "Recording"}
            </span>
            <meter
              aria-label="Microphone level"
              min={0}
              max={1}
              value={active.level}
            />
            <Button
              variant="primary"
              icon={Square}
              disabled={busy || active.stopping}
              onClick={() => void stop()}
            >
              Stop recording
            </Button>
          </div>
        ) : (
          <>
            <label className="field">
              Title
              <input
                aria-label="New voice note title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="tool-two-fields">
              <label className="field">
                Microphone
                <span className="tool-path">
                  <Select
                    label="Microphone input"
                    value={input}
                    onChange={setInput}
                    options={inputs.map((i) => ({
                      value: i.id,
                      label: i.name,
                    }))}
                  />
                  <Button
                    icon={RefreshCw}
                    size="sm"
                    onClick={() => void loadInputs()}
                    aria-label="Refresh microphones"
                  />
                </span>
              </label>
              <label className="field">
                Category
                <Select
                  label="Voice note category"
                  value={scope}
                  onChange={setScope}
                  options={categories}
                />
              </label>
            </div>
            {warning && <p className="muted">{warning}</p>}
            <label className="checkbox-field"><input type="checkbox" checked={liveWanted} onChange={e => setLiveWanted(e.target.checked)}/> Live transcript preview with local speech models</label>
            <div className="tool-actions">
              <Button
                icon={Mic}
                variant="primary"
                disabled={busy || !title.trim()}
                onClick={() => void start()}
              >
                Start recording
              </Button>
              <small>16 kHz mono WAV · full transcription after saving</small>
            </div>
          </>
        )}
        {lastSaved && (
          <div className="tool-result">
            <strong>Saved to Voice notes</strong>
            <span>{lastSaved.title}</span>
            <Button
              onClick={() => navigate({ page: "recording", id: lastSaved.id })}
            >
              Open recording
            </Button>
          </div>
        )}
      </section>
      <LiveTranscript/>
      {state!.recorder.sessions.length > 0 && (
        <section className="voice-drafts" aria-label="Unsaved voice recordings">
          <h2>Ready to save</h2>
          <p className="muted">
            These recordings are kept on disk until you save or discard them.
          </p>
          {state!.recorder.sessions.map((s) => (
            <VoiceDraft
              key={s.id}
              session={s}
              preview={preview?.id === s.id ? preview.url : undefined}
              onPreview={async () => {
                try {
                  setPreview({
                    id: s.id,
                    url: await api.recorderPreview(s.id),
                  });
                } catch (e) {
                  toast.error(e);
                }
              }}
              onSaved={(id, title) => {
                setPreview(undefined);
                setLastSaved({ id, title });
              }}
            />
          ))}
        </section>
      )}
    </>
  );
}
function VoiceDraft({
  session,
  preview,
  onPreview,
  onSaved,
}: {
  session: VoiceSession;
  preview?: string;
  onPreview: () => Promise<void>;
  onSaved: (id: string, title: string) => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [category, setCategory] = useState<string>(session.category);
  const [busy, setBusy] = useState(false);
  const [discard, setDiscard] = useState(false);
  const { reload, state } = useTools();
  const previewRunning = !!state?.liveTranscript?.running && state.liveTranscript.id === session.id;
  const { refresh, device } = useApp();
  const toast = useToast();
  const save = async (transcribe: boolean) => {
    setBusy(true);
    try {
      const result = await api.recorderSave(
        session.id,
        title,
        category,
        transcribe,
        device,
      );
      onSaved(result.id, title);
      await reload();
      refresh();
      if (result.warning) toast.error(result.warning);
      else
        toast.success(
          transcribe
            ? "Saved and queued for transcription"
            : "Voice note saved",
        );
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.recorderDiscard(session.id);
      setDiscard(false);
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="tool-panel voice-draft">
      <div className="tool-heading">
        <Mic size={18} />
        <div>
          <h3>{session.title}</h3>
          <small>
            {clock(session.seconds)}
            {session.status === "recovered" && " · Recovered after restart"}
          </small>
        </div>
      </div>
      {session.error && <p className="field-error">{session.error}</p>}
      {!!session.preview?.length && <details><summary>Transcript preview · latest sections</summary><PreviewText passages={session.preview}/></details>}
      <div className="tool-two-fields">
        <label className="field">
          Title
          <input
            aria-label="Saved voice note title"
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          Category
          <Select
            label="Saved voice note category"
            value={category}
            disabled={busy}
            onChange={setCategory}
            options={categories}
          />
        </label>
      </div>
      {preview ? (
        <audio
          controls
          src={preview}
          preload="metadata"
          aria-label="Voice recording preview"
        />
      ) : (
        <Button
          icon={Play}
          disabled={busy || session.seconds <= 0}
          onClick={() => void onPreview()}
        >
          Listen
        </Button>
      )}
      <div className="tool-actions">
        <Button
          variant="primary"
          icon={Save}
          disabled={busy || !title.trim() || session.seconds <= 0}
          onClick={() => void save(false)}
        >
          Save to library
        </Button>
        <Button
          disabled={busy || !title.trim() || session.seconds <= 0}
          onClick={() => void save(true)}
        >
          Save &amp; transcribe
        </Button>
        <Button
          variant="ghost"
          icon={Trash2}
          disabled={busy || previewRunning}
          onClick={() => setDiscard(true)}
        >
          Discard…
        </Button>
      </div>
      <Dialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard voice recording?"
        description="This permanently removes this unsaved recording. It has not been added to your library."
        footer={
          <>
            <Button onClick={() => setDiscard(false)}>Keep recording</Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => void remove()}
            >
              Discard recording
            </Button>
          </>
        }
      />
    </article>
  );
}
