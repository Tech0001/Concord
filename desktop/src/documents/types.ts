export type DocumentInfo = {
  id: string;
  title: string;
  length: number;
  path?: string | null;
  root_id?: string | null;
  relative?: string | null;
  starred?: number;
  category?: string;
  missing?: number;
  error?: string | null;
  author?: string | null;
  content_hash?: string | null;
};
export type DocumentRoot = {
  id: string;
  path: string;
  label: string;
  enabled: number;
  connected: boolean;
  error?: string | null;
  last_scan?: string | null;
};
export type DocumentsState = { roots: DocumentRoot[]; docs: DocumentInfo[] };
export type DocumentSync = {
  added: number;
  updated: number;
  missing: number;
  unchanged: number;
  errors: string[];
};
