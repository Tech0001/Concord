export type PreviewPassage = { start: number; end: number; text: string };
export type LiveTranscriptState = { id: string; running: boolean; message: string; error: string; device: string; processedSeconds: number; lagSeconds: number; passages: PreviewPassage[] };
export type Extraction = {
  running: boolean;
  source: string;
  destination: string;
  progress: number;
  message: string;
  error: string;
  complete: boolean;
  bytes: number;
  duration: number;
};
export type VoiceSession = {
  id: string;
  title: string;
  category: "personal" | "work";
  createdAt: string;
  status: string;
  error: string;
  seconds: number;
  preview?: PreviewPassage[];
};
export type ToolsState = {
  extract: Extraction;
  liveTranscript?: LiveTranscriptState;
  recorder: {
    active: {
      id: string;
      seconds: number;
      level: number;
      stopping: boolean;
    } | null;
    sessions: VoiceSession[];
  };
};
