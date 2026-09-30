export type Media = {
  id: string;
  title: string;
  channel: string;
  date: string;
  duration: number;
  path: string | null;
  transcript: string | null;
  words: number;
  status: string;
  speaker_count?: number;
  speaker_names?: string | null;
};
export type Segment = {
  start: number;
  end: number;
  text: string;
  speaker?: string | null;
};
export type Assignment = {
  local_id: string;
  speaker_id: string | null;
  name: string | null;
  color: string | null;
  airtime: number;
};
export type Recording = {
  media: Media;
  segments: Segment[];
  assignments: Assignment[];
  model: string;
};
export type Overview = {
  media: number;
  speakers: number;
  notes: number;
  docs: number;
  dataRoot: string;
  legacyDatabase: string;
};
export type Speaker = {
  id: string;
  name: string;
  color: string | null;
  notes: string | null;
  recordings: number;
  airtime: number;
};
export type Note = {
  id?: string;
  title: string;
  body: string;
  quote?: string;
  media_id?: string | null;
  start?: number | null;
  end?: number | null;
};
export type Research = {
  notes: Note[];
  links: { source: string; target: string; kind: string }[];
  docs: { id: string; title: string; length: number }[];
};
export type Job = {
  id: string;
  media_id: string;
  title: string;
  status: string;
  message: string;
};
export type Runtime = {
  ready: boolean;
  device: string;
  gpu?: string;
  modelsReady: boolean;
  voiceMatchingReady: boolean;
  model: string;
  models: string;
  python: string;
};
