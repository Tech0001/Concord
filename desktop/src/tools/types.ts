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
};
export type ToolsState = {
  extract: Extraction;
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
