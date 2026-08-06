import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import FileInput from "@/components/FileInput";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Download, FileAudio, Loader2 } from "lucide-react";

interface ExtractResult {
  outputPath: string;
  sizeBytes: number;
  durationSeconds: number | null;
  downloadToken: string;
}

type Format = "m4a" | "mp3";

/**
 * Extract Audio — standalone utility for pulling the audio track out of
 * any video file on the server's disk (e.g. a screen recording whose
 * video is broken but whose audio is fine). Not tied to the Library.
 *
 * Design doc: docs/superpowers/specs/2026-08-06-extract-audio-design.md
 */
export default function Extract() {
  const { toast } = useToast();
  const [filePath, setFilePath] = useState("");
  const [format, setFormat] = useState<Format>("m4a");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExtractResult | null>(null);

  const extract = async () => {
    setBusy(true);
    setResult(null);
    try {
      const res = await apiRequest("POST", "/api/tools/extract-audio", {
        path: filePath.trim(),
        format,
      });
      setResult(await res.json());
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Extraction failed",
        description: parseError(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileAudio className="h-4 w-4 text-primary" />
            Extract audio from a video
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="extract-path" className="text-xs font-medium text-muted-foreground">
              Video file (path on this computer)
            </label>
            <FileInput
              id="extract-path"
              value={filePath}
              onChange={setFilePath}
              placeholder="/path/to/recording.mp4"
              prompt="Choose a video file"
            />
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">Format</span>
            <div className="flex gap-1.5">
              <FormatButton
                active={format === "m4a"}
                onClick={() => setFormat("m4a")}
                label="M4A"
                hint="instant, lossless copy"
              />
              <FormatButton
                active={format === "mp3"}
                onClick={() => setFormat("mp3")}
                label="MP3"
                hint="re-encode, plays anywhere"
              />
            </div>
          </div>

          <Button onClick={extract} disabled={busy || !filePath.trim()}>
            {busy
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Extracting…</>
              : "Extract audio"}
          </Button>

          {result && (
            <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-2">
              <div className="font-medium">✓ Saved</div>
              <div className="break-all font-mono text-xs text-muted-foreground">
                {result.outputPath}
              </div>
              <div className="text-xs text-muted-foreground">
                {formatSize(result.sizeBytes)}
                {result.durationSeconds != null && <> · {formatDuration(result.durationSeconds)}</>}
              </div>
              <a
                href={`/api/tools/extract-audio/download?token=${encodeURIComponent(result.downloadToken)}`}
                download
              >
                <Button size="sm" variant="outline" className="h-7 text-xs">
                  <Download className="h-3.5 w-3.5" />
                  Download
                </Button>
              </a>
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            The audio file is written next to the source video — an existing
            file is never overwritten. M4A stream-copies AAC audio without
            re-encoding, so it's identical quality and takes about a second.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function FormatButton({ active, onClick, label, hint }: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      onClick={onClick}
      className="h-8 text-xs"
    >
      {label}
      <span className={active ? "opacity-80 font-normal" : "text-muted-foreground font-normal"}>
        — {hint}
      </span>
    </Button>
  );
}

/** apiRequest throws `${status}: ${bodyText}` — pull the server's
 *  {error} message out of the JSON body when present. */
function parseError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const jsonStart = msg.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(msg.slice(jsonStart));
      if (typeof parsed.error === "string") return parsed.error;
    } catch { /* fall through to raw message */ }
  }
  return msg;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}
