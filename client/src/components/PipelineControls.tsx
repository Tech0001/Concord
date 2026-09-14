import { useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Loader2, Play, RefreshCw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePipelineSetup, refreshPipelineSetup } from "@/hooks/use-pipeline-setup";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

interface PipelineStatus { status: "idle" | "running" | "sleeping" | "stopped" }
const statusKey = ["/api/pipeline/status"];

export function PipelineControls() {
  const { data: setup } = usePipelineSetup();
  const { data: state, isError } = useQuery<PipelineStatus>({
    queryKey: statusKey,
    staleTime: 5_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });
  const { toast } = useToast();

  useEffect(() => {
    const events = new EventSource("/api/pipeline/events");
    events.addEventListener("state", event => {
      try {
        const state = JSON.parse(event.data);
        if (["idle", "running", "sleeping", "stopped"].includes(state?.status)) {
          queryClient.setQueryData(statusKey, state);
        }
      } catch { /* A malformed event is recovered by the status query. */ }
    });
    events.onerror = () => { void queryClient.invalidateQueries({ queryKey: statusKey }); };
    return () => events.close();
  }, []);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: statusKey });
    void queryClient.invalidateQueries({ queryKey: ["/api/status"] });
  };
  const reportError = (title: string, error: Error) => {
    toast({ variant: "destructive", title, description: error.message });
    void refreshPipelineSetup();
    refresh();
  };
  const control = useMutation({
    mutationFn: async (action: "start" | "stop") => {
      const response = await apiRequest("POST", `/api/pipeline/${action}`);
      return response.json() as Promise<PipelineStatus>;
    },
    onSuccess: (result, action) => {
      queryClient.setQueryData<PipelineStatus>(statusKey, previous => ({ ...previous, status: result.status }));
      refresh();
      toast({ title: action === "start" ? "Pipeline started" : "Pipeline stopped" });
    },
    onError: (error, action) => reportError(`Could not ${action} pipeline`, error),
  });
  const check = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/pipeline/check-now");
      return response.json() as Promise<{ newVideos: number; scannedChannels: number }>;
    },
    onSuccess: result => {
      refresh();
      toast({
        title: "Check complete",
        description: `${result.newVideos} new item${result.newVideos === 1 ? "" : "s"} queued from ${result.scannedChannels} source${result.scannedChannels === 1 ? "" : "s"}.`,
      });
    },
    onError: error => reportError("Could not check for new items", error),
  });

  const running = state?.status === "running";
  const available = !!state && !isError;
  const ready = available && setup?.ready === true;
  const label = isError ? "Unavailable" : !state ? "Connecting…" : check.isPending ? "Checking…" : running ? "Running" : setup && !setup.ready ? "Setup required" : "Stopped";
  const setupHint = setup && !setup.ready ? "Finish Pipeline setup first" : "Waiting for Pipeline status";
  const buttonClass = "h-7 w-7 gap-1.5 px-0 text-xs xl:w-auto xl:px-2 [&_svg]:size-3.5";

  return (
    <div role="group" aria-label="Pipeline controls" className="flex shrink-0 items-center gap-0.5 rounded-md border bg-background/60 p-0.5">
      <Link
        href={setup && !setup.ready ? "/pipeline/setup" : "/pipeline"}
        title={`Pipeline: ${label}`}
        aria-label={`Pipeline: ${label}`}
        className="flex h-7 items-center gap-1.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-secondary"
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", isError ? "bg-amber-500" : running ? "bg-emerald-500" : "bg-muted-foreground/60")} />
        <span aria-live="polite" className="hidden lg:inline">{label}</span>
      </Link>
      <Button
        size="sm" variant="ghost" className={buttonClass}
        aria-label="Start pipeline" title={!ready ? setupHint : running ? "Pipeline is already running" : "Start pipeline"}
        disabled={!ready || running || control.isPending || check.isPending}
        onClick={() => control.mutate("start")}
      >
        {control.isPending && control.variables === "start" ? <Loader2 className="animate-spin" /> : <Play />}
        <span className="hidden xl:inline">Start</span>
      </Button>
      <Button
        size="sm" variant="ghost" className={buttonClass}
        aria-label="Stop pipeline" title="Stop pipeline"
        disabled={!running || control.isPending}
        onClick={() => control.mutate("stop")}
      >
        {control.isPending && control.variables === "stop" ? <Loader2 className="animate-spin" /> : <Square />}
        <span className="hidden xl:inline">Stop</span>
      </Button>
      <Button
        size="sm" variant="ghost" className={buttonClass}
        aria-label={check.isPending ? "Checking for new items" : "Check for new items"}
        title={!ready ? setupHint : "Check sources for new items"}
        disabled={!ready || control.isPending || check.isPending}
        onClick={() => check.mutate()}
      >
        <RefreshCw className={check.isPending ? "animate-spin" : undefined} />
        <span className="hidden xl:inline">{check.isPending ? "Checking…" : "Check"}</span>
      </Button>
    </div>
  );
}
