import type { Edge } from "@xyflow/react";
import type { VideoDrawerEntry } from "@/components/VideoDrawer";
import { LINK_KIND_COLORS, type ClipLinkKind, type GraphNodeData, type GraphEdgeData, type FlowEdgePayload, type LayoutMode } from "./types";

// Display helpers ----------------------------------------------------------

export function formatUploadDate(uploadDate: string | null): string {
  if (!uploadDate) return "No date";
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }
  return uploadDate;
}

export function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

// Color choices ------------------------------------------------------------

/** Pick the stroke color for an edge. Manual links dispatch on their
 *  specific sub-kind (Same Topic = blue, Contradicts = red, etc. — see
 *  LINK_KINDS in types.ts). Automatically-generated edges (shared_tag,
 *  same_video) use theme tokens so they recede behind the manual ones. */
export function edgeColor(kind: GraphEdgeData["kind"], manualKind?: string | null): string {
  if (kind === "manual") {
    if (manualKind && manualKind in LINK_KIND_COLORS) {
      return LINK_KIND_COLORS[manualKind as ClipLinkKind];
    }
    return "var(--primary)";
  }
  if (kind === "same_video") return "var(--muted-foreground)";
  return "var(--ring)";
}

export function channelColor(channelId: string | null | undefined): string {
  // Standalone notes have no channel — use a neutral muted color so they're
  // visually distinguishable from channel-anchored notes.
  if (!channelId) return "#9ca3af";
  const palette = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#be123c", "#4f46e5"];
  let hash = 0;
  for (const char of channelId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

export function primaryTag(node: GraphNodeData): string {
  return node.tags[0] || "untagged";
}

// Identity / URL helpers --------------------------------------------------

export function videoNodeId(clip: Pick<GraphNodeData, "channelId" | "videoId">): string {
  return `video:${clip.channelId}:${clip.videoId}`;
}

export function makeMapKey(
  mode: LayoutMode,
  params: { q: string; channelId: string; tags: string[]; limit: number },
): string {
  const tags = [...params.tags].sort().join(",");
  return `${mode}|channel=${params.channelId}|q=${params.q.trim()}|tags=${tags}|limit=${params.limit}`;
}

export function buildGraphUrl(params: {
  q: string;
  channelId: string;
  tags: string[];
  edgeTypes: string[];
  limit: number;
}): string {
  const search = new URLSearchParams({
    limit: String(params.limit),
    channelId: params.channelId,
    edgeTypes: params.edgeTypes.join(","),
    t: String(Date.now()),
  });
  if (params.q.trim()) search.set("q", params.q.trim());
  if (params.tags.length) search.set("tags", params.tags.join(","));
  return `/api/clips/graph?${search.toString()}`;
}

// Bridges to other parts of the app ---------------------------------------

export function clipToDrawerEntry(clip: GraphNodeData): VideoDrawerEntry {
  return {
    video_id: clip.videoId,
    channel_id: clip.channelId,
    channel_name: clip.channelName || clip.channelId,
    title: clip.title,
    upload_date: clip.uploadDate,
    duration: clip.duration,
    status: clip.status,
    is_live: clip.isLive,
    video_path: clip.videoPath,
    md_path: clip.mdPath,
    word_count: 0,
  };
}

// React Flow edge styling --------------------------------------------------

export function edgeStyles(edge: GraphEdgeData): Partial<Edge> {
  return {
    label: edge.kind === "manual" ? edge.label.replace("_", " ") : undefined,
    type: "default",
    animated: false,
    reconnectable: edge.kind === "manual",
    style: {
      stroke: edgeColor(edge.kind, edge.manualKind),
      strokeWidth: edge.kind === "manual" ? 3 : Math.max(1, Math.min(5, edge.weight)),
      opacity: edge.kind === "shared_tag" ? 0.45 : 0.9,
    },
    labelBgPadding: [6, 3],
    labelBgBorderRadius: 4,
    labelBgStyle: { fill: "var(--background)", fillOpacity: 0.95 },
    labelStyle: { fontSize: 10, fill: "var(--foreground)" },
    data: edge as FlowEdgePayload,
  };
}
