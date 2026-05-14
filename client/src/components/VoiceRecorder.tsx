import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Mic, Square, Loader2, Trash2 } from "lucide-react";
import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { PCM_WORKLET_SOURCE } from "@/lib/pcm-worklet";

type Phase = "idle" | "starting" | "recording" | "stopping" | "saving" | "done" | "error";

interface VoiceRecorderProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Mic recording sheet. Captures audio via getUserMedia + AudioWorklet,
 * downsamples to 16 kHz mono int16 in the worklet, ships ~10s chunks to
 * the server which appends them to a growing WAV file (crash-safe) AND
 * runs FluidAudio offline on each chunk for the live preview transcript.
 * On stop, the server finalizes the file and enqueues it into the
 * synthetic "Voice notes" channel for the authoritative full-audio
 * offline pass — that's the transcript that gets stored.
 */
export function VoiceRecorder({ open, onOpenChange }: VoiceRecorderProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [transcript, setTranscript] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [durationSec, setDurationSec] = useState(0);
  // Set once the server confirms a finalized save — used to render the
  // "Open in Library" call-to-action.
  const [savedVideoId, setSavedVideoId] = useState<string | null>(null);
  const [savedChannelId, setSavedChannelId] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const workletUrlRef = useRef<string | null>(null);
  // Queue chunk uploads so we never have two in flight at once for the
  // same session — keeps server-side transcript ordering deterministic.
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const durationTimerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const teardown = useCallback(() => {
    if (durationTimerRef.current) {
      window.clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch { /* noop */ }
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => { /* noop */ });
      audioContextRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
    if (workletUrlRef.current) {
      URL.revokeObjectURL(workletUrlRef.current);
      workletUrlRef.current = null;
    }
  }, []);

  // Reset every time the sheet opens fresh.
  useEffect(() => {
    if (!open) {
      teardown();
      return;
    }
    setPhase("idle");
    setTranscript("");
    setErrorMsg("");
    setDurationSec(0);
    setSavedVideoId(null);
    setSavedChannelId(null);
    sessionIdRef.current = null;
  }, [open, teardown]);

  // Belt-and-braces cleanup on unmount.
  useEffect(() => () => teardown(), [teardown]);

  const uploadChunk = useCallback(async (pcm: ArrayBuffer) => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/voice-notes/${sessionId}/chunk`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: pcm,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn("[voice] chunk upload failed:", res.status, body);
        return;
      }
      const data = await res.json() as { transcript?: string };
      if (typeof data.transcript === "string") setTranscript(data.transcript);
    } catch (err) {
      // Network blip — keep recording so we don't lose audio. Server has
      // the prior chunks; missing one just means the preview transcript
      // is a few seconds behind. The final offline pass will reconcile.
      console.warn("[voice] chunk upload error:", err);
    }
  }, []);

  const handleStart = useCallback(async () => {
    setPhase("starting");
    setErrorMsg("");
    setTranscript("");
    setSavedVideoId(null);
    setSavedChannelId(null);

    try {
      // Ask the server to allocate the session first so we have a
      // session id to attach chunks to. On failure we bail before
      // touching the mic.
      const startRes = await apiRequest("POST", "/api/voice-notes/start", {});
      const startData = await startRes.json() as { sessionId: string };
      sessionIdRef.current = startData.sessionId;

      // Open the mic. On the packaged app this triggers the macOS
      // microphone-permission prompt the first time.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      streamRef.current = stream;

      // AudioContext + worklet. The processor downsamples to 16 kHz
      // mono int16 and posts ~10s chunks back via .port.onmessage.
      const ctx = new AudioContext();
      audioContextRef.current = ctx;
      const blob = new Blob([PCM_WORKLET_SOURCE], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      workletUrlRef.current = url;
      await ctx.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(ctx, "pcm-downsampler", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
      });
      workletNodeRef.current = node;
      node.port.onmessage = (e: MessageEvent<ArrayBuffer | { type: string }>) => {
        if (e.data instanceof ArrayBuffer) {
          const pcm = e.data;
          // Serialize uploads — the worklet won't ship the next chunk
          // until ~10s later anyway, but on flush we might get a
          // partial right after a full one. Queue keeps ordering tight.
          uploadQueueRef.current = uploadQueueRef.current.then(() => uploadChunk(pcm));
        }
      };
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);

      startedAtRef.current = Date.now();
      durationTimerRef.current = window.setInterval(() => {
        setDurationSec((Date.now() - startedAtRef.current) / 1000);
      }, 250);

      setPhase("recording");
    } catch (err) {
      console.error("[voice] start failed:", err);
      setErrorMsg(err instanceof Error ? err.message : "Could not start recording");
      setPhase("error");
      teardown();
    }
  }, [teardown, uploadChunk]);

  const handleStop = useCallback(async () => {
    if (phase !== "recording") return;
    setPhase("stopping");

    // Ask the worklet to flush any partial buffer before tearing down.
    const node = workletNodeRef.current;
    const flushed = node
      ? new Promise<void>((resolve) => {
          const onMsg = (e: MessageEvent) => {
            if (e.data && e.data.type === "flushed") {
              node.port.removeEventListener("message", onMsg as EventListener);
              resolve();
            }
          };
          node.port.addEventListener("message", onMsg as EventListener);
          node.port.postMessage({ type: "flush" });
          window.setTimeout(resolve, 1500); // safety
        })
      : Promise.resolve();
    await flushed;
    // Wait for any in-flight chunk uploads to drain before finalize.
    await uploadQueueRef.current;
    teardown();

    setPhase("saving");
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      setPhase("error");
      setErrorMsg("Session was lost — try again.");
      return;
    }
    try {
      const res = await apiRequest("POST", `/api/voice-notes/${sessionId}/finalize`, {});
      const data = await res.json() as { videoId: string; channelId: string };
      setSavedVideoId(data.videoId);
      setSavedChannelId(data.channelId);
      sessionIdRef.current = null;
      setPhase("done");
      toast({
        title: "Voice note saved",
        description: "The full transcript will appear in your Library shortly.",
      });
    } catch (err) {
      console.error("[voice] finalize failed:", err);
      setErrorMsg(err instanceof Error ? err.message : "Failed to save voice note");
      setPhase("error");
    }
  }, [phase, teardown, toast]);

  const handleDiscard = useCallback(async () => {
    teardown();
    const sessionId = sessionIdRef.current;
    sessionIdRef.current = null;
    if (sessionId) {
      try { await apiRequest("POST", `/api/voice-notes/${sessionId}/cancel`, {}); } catch { /* noop */ }
    }
    setPhase("idle");
    setTranscript("");
    setDurationSec(0);
  }, [teardown]);

  const handleOpenInLibrary = useCallback(() => {
    if (!savedVideoId || !savedChannelId) return;
    onOpenChange(false);
    setLocation(`/library?channel=${encodeURIComponent(savedChannelId)}`);
  }, [savedVideoId, savedChannelId, onOpenChange, setLocation]);

  const formatDuration = (sec: number): string => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[420px] max-w-[100vw] flex-col gap-0 p-0">
        <SheetHeader className="border-b p-4">
          <SheetTitle className="flex items-center gap-2">
            <Mic className="h-4 w-4" />
            Voice note
          </SheetTitle>
          <SheetDescription className="text-xs">
            Mic → Concord. Audio saves to disk as you talk; the final
            transcript is produced by FluidAudio once you hit stop.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Phase-specific controls */}
          {phase === "idle" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <Button size="lg" onClick={handleStart} className="h-16 w-16 rounded-full p-0">
                <Mic className="h-6 w-6" />
              </Button>
              <p className="text-xs text-muted-foreground">Tap to start</p>
            </div>
          )}

          {phase === "starting" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-xs text-muted-foreground">Opening mic…</p>
            </div>
          )}

          {phase === "recording" && (
            <>
              <div className="flex flex-col items-center justify-center gap-3 py-2">
                <Button
                  size="lg"
                  variant="destructive"
                  onClick={handleStop}
                  className="h-16 w-16 rounded-full p-0"
                >
                  <Square className="h-6 w-6 fill-current" />
                </Button>
                <p className="font-mono text-sm tabular-nums">{formatDuration(durationSec)}</p>
                <p className="text-xs text-muted-foreground">Recording — tap to stop</p>
              </div>
            </>
          )}

          {(phase === "stopping" || phase === "saving") && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <Loader2 className="h-6 w-6 animate-spin" />
              <p className="text-xs text-muted-foreground">
                {phase === "stopping" ? "Wrapping up…" : "Saving…"}
              </p>
            </div>
          )}

          {phase === "done" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <p className="text-sm font-medium">Saved</p>
              <p className="text-xs text-muted-foreground text-center">
                The cleaned-up transcript will appear in your Library in a few seconds.
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setPhase("idle")}>
                  Record another
                </Button>
                <Button size="sm" onClick={handleOpenInLibrary}>
                  Open in Library
                </Button>
              </div>
            </div>
          )}

          {phase === "error" && (
            <div className="flex flex-col items-center justify-center gap-3 py-8">
              <p className="text-sm font-medium text-destructive">Something went wrong</p>
              <p className="text-xs text-muted-foreground text-center">{errorMsg}</p>
              <Button variant="outline" size="sm" onClick={() => setPhase("idle")}>
                Try again
              </Button>
            </div>
          )}

          {/* Live preview transcript. Marked "preview" so the user
              knows the final stored version will look cleaner. */}
          {(phase === "recording" || phase === "stopping" || phase === "saving") && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Live preview
                </h3>
                {phase === "recording" && transcript && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-destructive"
                    onClick={handleDiscard}
                  >
                    <Trash2 className="h-3 w-3" />
                    Discard
                  </button>
                )}
              </div>
              <div className="rounded-md border bg-muted/40 p-3 text-sm leading-relaxed text-muted-foreground min-h-[120px]">
                {transcript || (
                  <span className="text-xs italic">
                    Transcripts arrive in ~5 second chunks. They'll look rough at boundaries —
                    the saved version is cleaner.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
