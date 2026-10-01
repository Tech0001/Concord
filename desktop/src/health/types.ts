export type Coverage = { covered: number; total: number };
export type MaintenanceJob = {
  scope?: string;
  id: string;
  action: string;
  status: string;
  message: string;
  done: number;
  total: number;
  failed?: number;
  details?: string;
  created_at: string;
};
export type ArchiveStatus = {
  generatedAt: string;
  archive: {
    total: number;
    complete: number;
    hours: number;
    pending: number;
    failed: number;
    words: number;
  };
  coverage: {
    transcripts: Coverage;
    fts: Coverage;
    segments: number;
    embeddings: Coverage;
    summaries: Coverage;
    diarization: Coverage;
    documents: Coverage;
    documentEmbeddings: Coverage;
  };
  speakers: { total: number; unidentified: number };
  documents: { starred: number; personal: number; work: number };
  channels: {
    id: string;
    name: string;
    enabled: number | null;
    diarize: number;
    include_shorts: number;
    total: number;
    complete: number;
    pending: number;
    failed: number;
    embedded: number;
    summarized: number;
    diarized: number;
  }[];
  embedding: { model: string; dimensions: number | null; enabled: boolean };
  chat: { configured: boolean; model: string };
  jobs: MaintenanceJob[];
  aiJobs: MaintenanceJob[];
  restorePending: boolean;
};
export type HealthItem = {
  id: string;
  title: string;
  kind: string;
  detail: string;
};
export type HealthIssue = {
  id: string;
  category: string;
  severity: string;
  title: string;
  description: string;
  count: number;
  items: HealthItem[];
  repair: string | null;
};
export type Audit = {
  generatedAt: string;
  errors: number;
  warnings: number;
  databaseBytes: number;
  mediaBytes: number;
  issues: HealthIssue[];
};
export type BackupValidation = {
  path: string;
  bytes: number;
  recordings: number;
  notes: number;
  documents: number;
  version: number;
  includesConfiguration: boolean;
};
export type LogEntry = {
  id: number;
  timestamp: number;
  level: string;
  message: string;
};
