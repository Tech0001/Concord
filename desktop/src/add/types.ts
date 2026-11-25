export type DroppedFile = { path: string; name: string; bytes: number };
export type Inspected = { files: DroppedFile[]; folders: { path: string; name: string }[]; skipped: string[] };
export type FolderPreview = { name: string; path: string; files: number; existing: number; bytes: number };
export type LinkVideo = { url: string; id: string; title: string; channel: string; channelUrl: string | null; duration: number; date: string };
export type LinkPreview =
  | { input: string; kind: "video"; video: LinkVideo; existing: boolean; followingChannel: boolean }
  | { input: string; kind: "channel" | "playlist"; url: string; name: string; handle: string | null; latest: string; following: boolean }
  | { input: string; kind: "unsupported"; error: string }
  | { input: string; kind: "error"; error: string };
/** What opens Add: dropped or chosen paths, or pasted text with links. */
export type AddSeed = { paths?: string[]; text?: string };
export type DragDrop = { type: "enter" | "over" | "drop" | "leave"; paths: string[] };
