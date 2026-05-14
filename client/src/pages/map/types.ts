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
  // Each kind carries a stroke color used by every layout (Cards / Videos
  // / Arc / Cluster). Chosen so the meaning reads in both light and dark
  // themes; they're concrete hex values rather than CSS vars so SVG/canvas
  // renderers (d3, force-graph) see a real color string.
  { value: "same_claim",  label: "Same claim",  color: "#10b981" }, // emerald — agreement
  { value: "contradicts", label: "Contradicts", color: "#ef4444" }, // red — conflict
  { value: "same_topic",  label: "Same topic",  color: "#3b82f6" }, // blue — general relation
  { value: "follow_up",   label: "Follow-up",   color: "#8b5cf6" }, // violet — next step
  { value: "context",     label: "Context",     color: "#f59e0b" }, // amber — supporting info
] as const;

export type ClipLinkKind = (typeof LINK_KINDS)[number]["value"];

/** Quick-lookup map (kind value → color hex) for renderers that have
 *  just the manualKind string in hand. */
export const LINK_KIND_COLORS: Record<ClipLinkKind, string> =
  Object.fromEntries(LINK_KINDS.map(k => [k.value, k.color])) as Record<ClipLinkKind, string>;

export const DEFAULT_VIDEO_WIDTH = 360;
export const DEFAULT_VIDEO_HEIGHT = 310;
export const DEFAULT_CLIP_WIDTH = 224;
export const DEFAULT_CLIP_HEIGHT = 138;
