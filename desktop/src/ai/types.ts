export type Provider = {
  enabled: boolean;
  kind: "builtin" | "local" | "openrouter" | "custom";
  baseUrl: string;
  model: string;
  hasKey: boolean;
  local: boolean;
};
export type AiConfig = { embedding: Provider; chat: Provider };
export type SearchFilter = {
  exact: boolean;
  kind: string;
  channel: string;
  speaker: string;
  from: string;
  to: string;
  tag: string;
  mediaId: string;
};
export const EMPTY_FILTER: SearchFilter = {
  exact: false,
  kind: "",
  channel: "",
  speaker: "",
  from: "",
  to: "",
  tag: "",
  mediaId: "",
};
export type ResearchHit = {
  marked?: string | null;
  speaker?: string | null;
  speaker_name?: string | null;
  speaker_color?: string | null;
  kind: "recording" | "document" | "note";
  id: string;
  title: string;
  channel: string;
  date: string;
  text: string;
  start: number | null;
  end: number | null;
  score: number;
};
export type FilterOptions = {
  channels: { channel: string }[];
  speakers: { id: string; name: string }[];
  tags: { tag: string }[];
};
export type IndexStatus = {
  modelReady: boolean;
  indexed: number;
  total: number;
  chunks: number;
  dimensions: number | null;
  job: {
    id: string;
    status: string;
    message: string;
    done: number;
    total: number;
  } | null;
};
export type Conversation = {
  id: string;
  title: string;
  pinned: number;
  updated_at: string;
  messages: number;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string;
  sources: ResearchHit[];
  starred: number;
  error: number;
  created_at: string;
};
export type ChatDetail = {
  conversation: Conversation;
  messages: ChatMessage[];
};
export type Summary = {
  media_id: string;
  content: string;
  model: string;
  created_at: string;
};
export const chatReady = (p?: Provider) =>
  !!p?.enabled && !!p.model && (p.kind !== "openrouter" || p.hasKey);
