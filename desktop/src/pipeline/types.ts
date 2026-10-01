import type { Job } from "../lib/types.ts";
export type PipelineConfig = { device: string; retries: number; retryMinutes: number };
export type QueueJob = Job & { kind: string; device: string; attempts: number; retry_at: number; cancelled: number; channel: string; path: string | null; finished_at: string | null };
export type PipelineState = { running: boolean; config: PipelineConfig; jobs: QueueJob[]; channels: { channel: string }[] };
export type Batch = { ids?: string[]; channel?: string; query?: string; missingOnly?: boolean; device?: string };
export type Candidates = { total: number; eligible: number; unavailable: number; alreadyQueued: number; hours: number; items: { id: string; title: string; channel: string; date: string; path: string | null; transcript: string | null; duration: number }[] };
export type Enqueued = { added: number; ids: string[]; unavailable: number; alreadyQueued: number };
export const isPending = (status: string) => ["running", "queued", "retry", "waiting_live"].includes(status);
