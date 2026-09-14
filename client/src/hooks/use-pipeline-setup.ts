import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export interface PipelineSetupStatus {
  completed: boolean;
  ready: boolean;
  requirementsMet: boolean;
  checks: Array<{ id: "storage" | "downloads" | "transcription"; label: string; ready: boolean; detail: string }>;
}

export function usePipelineSetup() {
  return useQuery<PipelineSetupStatus>({ queryKey: ["/api/pipeline/setup"], staleTime: 15_000, refetchOnWindowFocus: true });
}

export async function refreshPipelineSetup() {
  await queryClient.invalidateQueries({ queryKey: ["/api/pipeline/setup"] });
}
