// Shared types + constants for the Map page. The page renders four
// different visualizations (ReactFlow video/clip modes, d3 arc, and a
// react-force-graph cluster) — all of them work over the same node /
// edge shape produced by `getClipGraph` on the server.

export interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface TagOption {
  tag: string;
  count: number;
}

export interface GraphAnchorData {
  ordinal: number;
  videoId: string;
  channelId: string;
  channelName: string | null;
  videoTitle: string | null;
  uploadDate: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
}

export interface GraphNodeData extends Record<string, unknown> {
  id: string;
  clipId: string;
  videoId: string;
  channelId: string;
  channelName: string | null;
  title: string;
  uploadDate: string | null;
  startSeconds: number;
  endSeconds: number;
  quote: string;
  note: string | null;
  tags: string[];
  videoPath: string | null;
  mdPath: string | null;
  status: string;
  isLive: number;
  duration: number | null;
  degree: number;
  anchors: GraphAnchorData[];
}

export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  kind: "manual" | "shared_tag" | "same_video";
  label: string;
  weight: number;
  tags?: string[];
  manualKind?: string;
  note?: string | null;
}

export type FlowEdgePayload = GraphEdgeData & Record<string, unknown>;

export interface GraphResponse {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    tagCount: number;
    manualEdgeCount: number;
    sharedTagEdgeCount: number;
    sameVideoEdgeCount: number;
  };
}

export interface LayoutNode {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VideoNodeData extends Record<string, unknown> {
  id: string;
  videoId: string;
  channelId: string;
  channelName: string | null;
  title: string;
  uploadDate: string | null;
  duration: number | null;
  clips: GraphNodeData[];
  width: number;
  height: number;
  selectedClipId: string | null;
  onClipSelect: (clip: GraphNodeData) => void;
  onOpenClip: (clip: GraphNodeData) => void;
  onResizeEnd: (nodeId: string, width: number, height: number) => void;
}

export type LayoutMode = "video" | "clip" | "arc" | "force";
export type ArcOrder = "tag" | "date" | "channel" | "title" | "connections";

export const LINK_KINDS = [
  { value: "same_claim", label: "Same claim" },
  { value: "contradicts", label: "Contradicts" },
  { value: "same_topic", label: "Same topic" },
  { value: "follow_up", label: "Follow-up" },
  { value: "context", label: "Context" },
] as const;

export type ClipLinkKind = (typeof LINK_KINDS)[number]["value"];

export const DEFAULT_VIDEO_WIDTH = 360;
export const DEFAULT_VIDEO_HEIGHT = 310;
export const DEFAULT_CLIP_WIDTH = 224;
export const DEFAULT_CLIP_HEIGHT = 138;
