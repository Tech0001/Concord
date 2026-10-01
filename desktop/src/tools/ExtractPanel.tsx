import { useEffect, useState } from "react";
import { AudioLines, FolderOpen, Square, Check } from "lucide-react";
import { api, MEDIA_EXTENSIONS } from "../lib/ipc.ts";
import { clock } from "../lib/format.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useTools } from "./ToolsContext.tsx";

function outputPath(source: string, format: string) {
  const slash = source.lastIndexOf("/");
  const stem = Array.from(source.slice(slash + 1).replace(/\.[^.]+$/, ""))
    .slice(0, 40)
    .join("");
  return source.slice(0, slash + 1) + `${stem || "Recording"}-audio.${format}`;
}
export function ExtractPanel({ source: initial }: { source?: string }) {
  const { state, reload } = useTools();
  const toast = useToast();
  const job = state!.extract;
  const [source, setSource] = useState(initial ?? job.source ?? "");
  const [format, setFormat] = useState("m4a");
  const [destination, setDestination] = useState(
    initial ? outputPath(initial, "m4a") : (job.destination ?? ""),
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (initial) {
      setSource(initial);
      setDestination(outputPath(initial, "m4a"));
      setFormat("m4a");
    }
  }, [initial]);
  const disabled = busy || job.running;
  const chooseSource = async () => {
    try {
      const paths = await api.pickFiles({
        title: "Extract audio from a file",
        name: "Audio and video",
        extensions: MEDIA_EXTENSIONS,
        multiple: false,
      });
      if (paths[0]) {
        setSource(paths[0]);
        setDestination(outputPath(paths[0], format));
      }
    } catch (e) {
      toast.error(e);
    }
  };
  const chooseOutput = async () => {
    try {
      const path = await api.pickSavePath({
        title: "Save extracted audio",
        name: format.toUpperCase() + " audio",
        extensions: [format],
        defaultPath: destination || outputPath(source, format),
      });
      if (path) setDestination(path);
    } catch (e) {
      toast.error(e);
    }
  };
  const start = async () => {
    setBusy(true);
    try {
      await api.toolsExtract(source, destination, format);
      await reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="tool-panel" aria-label="Audio extraction">
      <div className="tool-heading">
        <AudioLines size={22} />
        <div>
          <h2>Audio from any recording</h2>
          <p>
            Save an audio-only copy without adding the source to your library.
          </p>
        </div>
      </div>
      <label className="field">
        Source file
        <span className="tool-path">
          <input
            aria-label="Audio extraction source"
            value={source}
            disabled={disabled}
            placeholder="Choose a video or audio file"
            onChange={(e) => {
              setSource(e.target.value);
              setDestination(outputPath(e.target.value, format));
            }}
          />
          <Button
            icon={FolderOpen}
            disabled={disabled}
            onClick={() => void chooseSource()}
          >
            Browse
          </Button>
        </span>
      </label>
      <label className="field">
        Audio format
        <Select
          label="Extracted audio format"
          value={format}
          onChange={(v) => {
            setFormat(v);
            setDestination(outputPath(source, v));
          }}
          disabled={disabled}
          options={[
            { value: "m4a", label: "M4A · original AAC when available" },
            { value: "mp3", label: "MP3 · widely compatible" },
          ]}
        />
      </label>
      <label className="field">
        Save to
        <span className="tool-path">
          <input
            aria-label="Audio extraction destination"
            value={destination}
            disabled={disabled}
            placeholder="Output file path"
            onChange={(e) => setDestination(e.target.value)}
          />
          <Button
            icon={FolderOpen}
            disabled={disabled}
            onClick={() => void chooseOutput()}
          >
            Choose…
          </Button>
        </span>
        <small>
          Uses the first audio track. Existing files are never overwritten.
        </small>
      </label>
      <div className="tool-actions">
        {job.running ? (
          <Button
            icon={Square}
            onClick={() => void api.toolsCancelExtract().catch(toast.error)}
          >
            Cancel extraction
          </Button>
        ) : (
          <Button
            variant="primary"
            icon={AudioLines}
            disabled={busy || !source.trim() || !destination.trim()}
            onClick={() => void start()}
          >
            Extract audio
          </Button>
        )}
      </div>
      {job.message && (
        <div className="tool-result" role="status">
          <strong>
            {job.complete && <Check size={16} />} {job.message}
          </strong>
          {job.running && (
            <>
              <progress
                aria-label="Audio extraction progress"
                max={1}
                value={job.progress}
              />
              <small className="num">
                {Math.round(job.progress * 100)}% ·{" "}
                {job.source.split("/").pop()}
              </small>
            </>
          )}
          {job.error && <p className="field-error">{job.error}</p>}
          {job.complete && (
            <>
              <p className="tool-filename">{job.destination}</p>
              <small>
                {(job.bytes / 1048576).toFixed(1)} MB
                {job.duration > 0 && ` · ${clock(job.duration)}`}
              </small>
              <Button
                size="sm"
                icon={FolderOpen}
                onClick={() =>
                  void api.reveal(job.destination).catch(toast.error)
                }
              >
                Show in folder
              </Button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
