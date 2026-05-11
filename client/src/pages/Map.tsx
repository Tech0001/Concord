import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  NodeResizer,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeMouseHandler,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
  type OnNodeDrag,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import * as d3 from "d3";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagChip, TagPicker } from "@/components/TagPicker";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Calendar, ChevronDown, Clock, GitBranch, LayoutGrid, Link2, Loader2, Map as MapIcon, Play, RefreshCw, Scaling, Search, Spline, StickyNote, Trash2, X, Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";

interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

interface TagOption {
  tag: string;
  count: number;
}

interface GraphAnchorData {
  ordinal: number;
  videoId: string;
  channelId: string;
  channelName: string | null;
  videoTitle: string | null;
  uploadDate: string | null;
  startSeconds: number | null;
  endSeconds: number | null;
}

interface GraphNodeData extends Record<string, unknown> {
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

interface GraphEdgeData {
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

type FlowEdgePayload = GraphEdgeData & Record<string, unknown>;

interface GraphResponse {
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

interface LayoutNode {
  nodeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface VideoNodeData extends Record<string, unknown> {
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

type LayoutMode = "video" | "clip" | "arc" | "force";
type ArcOrder = "tag" | "date" | "channel" | "title" | "connections";

const LINK_KINDS = [
  { value: "same_claim", label: "Same claim" },
  { value: "contradicts", label: "Contradicts" },
  { value: "same_topic", label: "Same topic" },
  { value: "follow_up", label: "Follow-up" },
  { value: "context", label: "Context" },
] as const;

type ClipLinkKind = (typeof LINK_KINDS)[number]["value"];

const DEFAULT_VIDEO_WIDTH = 360;
const DEFAULT_VIDEO_HEIGHT = 310;
const DEFAULT_CLIP_WIDTH = 224;
const DEFAULT_CLIP_HEIGHT = 138;

function formatUploadDate(uploadDate: string | null): string {
  if (!uploadDate) return "No date";
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }
  return uploadDate;
}

function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function edgeColor(kind: GraphEdgeData["kind"]): string {
  if (kind === "manual") return "var(--primary)";
  if (kind === "same_video") return "var(--muted-foreground)";
  return "var(--ring)";
}

function channelColor(channelId: string | null | undefined): string {
  // Standalone notes have no channel — use a neutral muted color so they're
  // visually distinguishable from channel-anchored notes.
  if (!channelId) return "#9ca3af";
  const palette = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#ea580c", "#0891b2", "#be123c", "#4f46e5"];
  let hash = 0;
  for (const char of channelId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function primaryTag(node: GraphNodeData): string {
  return node.tags[0] || "untagged";
}

function videoNodeId(clip: Pick<GraphNodeData, "channelId" | "videoId">): string {
  return `video:${clip.channelId}:${clip.videoId}`;
}

function makeMapKey(mode: LayoutMode, params: { q: string; channelId: string; tags: string[]; limit: number }): string {
  const tags = [...params.tags].sort().join(",");
  return `${mode}|channel=${params.channelId}|q=${params.q.trim()}|tags=${tags}|limit=${params.limit}`;
}

function buildGraphUrl(params: {
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

function clipToDrawerEntry(clip: GraphNodeData): VideoDrawerEntry {
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

function edgeStyles(edge: GraphEdgeData): Partial<Edge> {
  return {
    label: edge.kind === "manual" ? edge.label.replace("_", " ") : undefined,
    type: "default",
    animated: false,
    reconnectable: edge.kind === "manual",
    style: {
      stroke: edgeColor(edge.kind),
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

function ClipNode({ data, selected }: { data: GraphNodeData; selected?: boolean }) {
  // Multi-anchor notes show their anchor list inline so the map surface
  // reveals the cross-video reach of a single thought. Standalone notes
  // (zero anchors) render the note body instead.
  const anchors = Array.isArray(data.anchors) ? data.anchors : [];
  const multiAnchor = anchors.length > 1;
  const standalone = anchors.length === 0;

  return (
    <div
      className={cn(
        "relative rounded-md border bg-card p-2 text-card-foreground shadow-sm",
        selected && "ring-2 ring-ring",
      )}
      style={{ width: DEFAULT_CLIP_WIDTH, borderLeft: `4px solid ${channelColor(data.channelId)}` }}
    >
      <Handle type="target" position={Position.Left} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
      <Handle type="source" position={Position.Right} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
      <div className="line-clamp-2 text-xs font-medium leading-4">{data.title}</div>
      <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
        {standalone
          ? <span>standalone</span>
          : multiAnchor
            ? <span>{anchors.length} anchors · {data.degree} links</span>
            : <>
                <span>{data.channelName || data.channelId}</span>
                <span>{formatTimestamp(data.startSeconds)}</span>
                <span>{data.degree} links</span>
              </>
        }
      </div>
      {data.note && (
        <p className="mt-1 line-clamp-2 text-[11px] leading-4">{data.note}</p>
      )}
      {!multiAnchor && !standalone && (
        <p className="mt-1 line-clamp-2 text-[11px] italic leading-4 text-muted-foreground">"{data.quote}"</p>
      )}
      {multiAnchor && (
        <ul className="mt-1 space-y-0.5 text-[10px] text-muted-foreground">
          {anchors.slice(0, 4).map((a) => (
            <li key={a.ordinal} className="flex items-baseline gap-1.5">
              <span className="truncate" title={a.videoTitle ?? ""}>{a.channelName || a.channelId}</span>
              <span className="font-mono">{a.startSeconds == null ? "all" : formatTimestamp(a.startSeconds)}</span>
            </li>
          ))}
          {anchors.length > 4 && (
            <li className="text-[10px] italic">+ {anchors.length - 4} more</li>
          )}
        </ul>
      )}
      {!!data.tags.length && (
        <div className="mt-1 flex flex-wrap gap-1">
          {data.tags.slice(0, 3).map(tag => <TagChip key={tag} tag={tag} variant="outline" />)}
        </div>
      )}
    </div>
  );
}

function VideoNode({ data, selected }: { data: VideoNodeData; selected?: boolean }) {
  return (
    <div
      className={cn(
        "relative flex h-full w-full flex-col rounded-md border bg-card text-card-foreground shadow-sm",
        selected && "ring-2 ring-ring",
      )}
      style={{ borderLeft: `4px solid ${channelColor(data.channelId)}` }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={300}
        minHeight={220}
        onResizeEnd={(_event, params) => data.onResizeEnd(data.id, params.width, params.height)}
      />
      <div className="border-b p-3">
        <div className="line-clamp-2 text-sm font-semibold leading-5">{data.title}</div>
        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
          <span>{data.channelName || data.channelId}</span>
          <span>{formatUploadDate(data.uploadDate)}</span>
          <span>{data.clips.length} {data.clips.length === 1 ? "anchor" : "anchors"}</span>
        </div>
      </div>
      <div className="nodrag nowheel flex-1 space-y-2 overflow-auto p-2">
        {data.clips.map((clip, idx) => (
          <div
            // Multi-anchor notes can appear more than once per video (one row
            // per anchor). anchorOrdinal disambiguates; the array index is a
            // belt-and-suspenders fallback for the rare legacy single-anchor
            // case where ordinal is missing.
            key={`${clip.id}-${typeof clip.anchorOrdinal === "number" ? clip.anchorOrdinal : idx}`}
            role="button"
            tabIndex={0}
            className={cn(
              "relative block w-full rounded border bg-background/70 py-2 pl-9 pr-9 text-left text-xs hover:bg-accent",
              data.selectedClipId === clip.id && "border-primary bg-primary/10",
            )}
            onClick={(event) => {
              event.stopPropagation();
              data.onClipSelect(clip);
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              data.onOpenClip(clip);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                data.onClipSelect(clip);
              }
            }}
          >
            <Handle
              id={`${clip.id}:${typeof clip.anchorOrdinal === "number" ? clip.anchorOrdinal : 1}`}
              type="target"
              position={Position.Left}
              className="!left-2 !h-5 !w-5 !border-2 !border-background !bg-primary"
            />
            <Handle
              id={`${clip.id}:${typeof clip.anchorOrdinal === "number" ? clip.anchorOrdinal : 1}`}
              type="source"
              position={Position.Right}
              className="!right-2 !h-5 !w-5 !border-2 !border-background !bg-primary"
            />
            <span className="pointer-events-none absolute left-8 top-1/2 h-px w-3 -translate-y-1/2 bg-primary/35" />
            <span className="pointer-events-none absolute right-8 top-1/2 h-px w-3 -translate-y-1/2 bg-primary/35" />
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-primary">{formatTimestamp(clip.startSeconds)}</span>
              <span className="text-[10px] text-muted-foreground">{clip.degree} links</span>
            </div>
            <p className="mt-1 line-clamp-2 leading-4 text-muted-foreground">{clip.quote}</p>
            {!!clip.tags.length && (
              <div className="mt-1 flex flex-wrap gap-1">
                {clip.tags.slice(0, 3).map(tag => <TagChip key={tag} tag={tag} variant="outline" />)}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="border-t px-3 py-2 text-[11px] text-muted-foreground">
        Drag from the right dot of one clip to the left dot of another.
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { clip: ClipNode, video: VideoNode };

export default function MapPage() {
  const [mode, setMode] = useState<LayoutMode>("video");
  const [arcOrder, setArcOrder] = useState<ArcOrder>("tag");
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const [channelId, setChannelId] = useState("all");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [edgeTypes, setEdgeTypes] = useState<string[]>(["manual"]);
  const [limit, setLimit] = useState(150);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tagOptions, setTagOptions] = useState<TagOption[]>([]);
  const [graph, setGraph] = useState<GraphResponse>({ nodes: [], edges: [], stats: {
    nodeCount: 0,
    edgeCount: 0,
    tagCount: 0,
    manualEdgeCount: 0,
    sharedTagEdgeCount: 0,
    sameVideoEdgeCount: 0,
  }});
  const [layoutById, setLayoutById] = useState<Map<string, LayoutNode>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedClip, setSelectedClip] = useState<GraphNodeData | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [flowNodesState, setFlowNodesState] = useState<Node[]>([]);
  const [linkSource, setLinkSource] = useState<GraphNodeData | null>(null);
  const [linkKind, setLinkKind] = useState<ClipLinkKind>("same_topic");
  const [linkNote, setLinkNote] = useState("");
  const flowNodesRef = useRef<Node[]>([]);
  const reconnectEdgeRef = useRef<Edge | null>(null);
  const reconnectSucceededRef = useRef(false);
  const { toast } = useToast();

  const selectedEdges = useMemo(() => {
    if (!selectedClip) return [];
    return graph.edges.filter(edge => edge.source === selectedClip.id || edge.target === selectedClip.id);
  }, [graph.edges, selectedClip]);

  const relatedClips = useMemo(() => {
    if (!selectedClip) return [];
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    return selectedEdges
      .map(edge => byId.get(edge.source === selectedClip.id ? edge.target : edge.source))
      .filter((node): node is GraphNodeData => !!node);
  }, [graph.nodes, selectedClip, selectedEdges]);

  const clipById = useMemo(() => new Map(graph.nodes.map(node => [node.id, node])), [graph.nodes]);
  const tagFilterKey = tagFilter.join(",");
  const edgeTypesKey = edgeTypes.join(",");
  const mapKey = useMemo(
    () => makeMapKey(mode, { q: appliedQuery, channelId, tags: tagFilter, limit }),
    [appliedQuery, channelId, limit, mode, tagFilterKey],
  );

  const saveLayoutNodes = useCallback(async (nodes: LayoutNode[]) => {
    if (!nodes.length || mode === "arc") return;
    setLayoutById(current => {
      const next = new Map(current);
      for (const node of nodes) next.set(node.nodeId, node);
      return next;
    });
    try {
      await apiRequest("PUT", "/api/clips/graph/layout", { mapKey, nodes });
    } catch (error: any) {
      toast({ variant: "destructive", title: "Layout save failed", description: error.message });
    }
  }, [mapKey, mode, toast]);

  const handleVideoResizeEnd = useCallback((nodeId: string, width: number, height: number) => {
    const node = flowNodesRef.current.find(item => item.id === nodeId);
    if (!node) return;
    void saveLayoutNodes([{
      nodeId,
      x: node.position.x,
      y: node.position.y,
      width,
      height,
    }]);
  }, [saveLayoutNodes]);

  const generatedFlowNodes = useMemo<Node[]>(() => {
    if (mode === "video") {
      // Bucket by EVERY anchor. A multi-anchor note appears under each of
      // its anchored videos with the per-anchor timestamp — that's the
      // killer surface of the map for cross-video research.
      //
      // Standalone notes (zero anchors with no video link) fall through to
      // freestanding clip nodes alongside the video containers.
      const videos = new Map<string, GraphNodeData[]>();
      const standaloneClips: GraphNodeData[] = [];
      for (const clip of graph.nodes) {
        const anchors = Array.isArray(clip.anchors) ? clip.anchors : [];
        if (anchors.length === 0) {
          // Defensive: an older note that predates anchor backfill might have
          // no anchors[] but still carry the legacy single-anchor columns.
          if (clip.videoId && clip.channelId) {
            const id = videoNodeId(clip);
            const list = videos.get(id);
            if (list) list.push(clip);
            else videos.set(id, [clip]);
          } else {
            standaloneClips.push(clip);
          }
          continue;
        }
        for (const anchor of anchors as Array<{ ordinal: number; videoId: string; channelId: string; startSeconds: number | null; endSeconds: number | null }>) {
          if (!anchor.videoId || !anchor.channelId) continue;
          // Project a per-anchor view: same note, but startSeconds/endSeconds
          // overridden so the row inside the video container shows the right
          // moment. anchorOrdinal lets the React key disambiguate when one
          // note has multiple anchors in the same video.
          const view: GraphNodeData = {
            ...clip,
            startSeconds: anchor.startSeconds ?? 0,
            endSeconds: anchor.endSeconds ?? anchor.startSeconds ?? 0,
            anchorOrdinal: anchor.ordinal,
          };
          const id = `video:${anchor.channelId}:${anchor.videoId}`;
          const list = videos.get(id);
          if (list) list.push(view);
          else videos.set(id, [view]);
        }
      }

      const entries = Array.from(videos.entries()).map(([id, clips]) => {
        clips.sort((a, b) => a.startSeconds - b.startSeconds);
        return [id, clips] as const;
      });
      const totalCells = entries.length + standaloneClips.length;
      const columns = Math.max(1, Math.ceil(Math.sqrt(totalCells)));
      const videoNodes: Node[] = entries.map(([id, clips], index) => {
        const first = clips[0];
        // The bucket id is `video:${channelId}:${videoId}` — parse it so the
        // header uses THIS video's title (joined from video_queue on the
        // anchor row) rather than the first note's title. For new AI-derived
        // notes the note title is e.g. "Bob's claim about X" — useless as a
        // video-container header.
        const [, bucketChannelId, bucketVideoId] = id.split(":");
        const anchorForThisVideo = first.anchors?.find((a) =>
          a.videoId === bucketVideoId && a.channelId === bucketChannelId,
        );
        const headerTitle = anchorForThisVideo?.videoTitle ?? first.title;
        const headerChannel = anchorForThisVideo?.channelName ?? first.channelName;
        const headerUpload = anchorForThisVideo?.uploadDate ?? first.uploadDate;
        const saved = layoutById.get(id);
        const width = saved?.width ?? DEFAULT_VIDEO_WIDTH;
        const height = saved?.height ?? Math.max(DEFAULT_VIDEO_HEIGHT, Math.min(520, 170 + clips.length * 88));
        const data: VideoNodeData = {
          id,
          videoId: bucketVideoId,
          channelId: bucketChannelId,
          channelName: headerChannel,
          title: headerTitle,
          uploadDate: headerUpload,
          duration: first.duration,
          clips,
          width,
          height,
          selectedClipId: selectedClip?.id || null,
          onClipSelect: setSelectedClip,
          onOpenClip: openClipVideo,
          onResizeEnd: handleVideoResizeEnd,
        };
        return {
          id,
          type: "video",
          data,
          position: saved ? { x: saved.x, y: saved.y } : {
            x: (index % columns) * 430,
            y: Math.floor(index / columns) * 380,
          },
          style: { width, height },
        };
      });
      const standaloneNodes: Node[] = standaloneClips.map((node, idx) => {
        const offset = entries.length + idx;
        const saved = layoutById.get(node.id);
        return {
          id: node.id,
          type: "clip",
          data: node,
          position: saved ? { x: saved.x, y: saved.y } : {
            x: (offset % columns) * 430,
            y: Math.floor(offset / columns) * 380,
          },
          style: { width: saved?.width ?? DEFAULT_CLIP_WIDTH, height: saved?.height ?? DEFAULT_CLIP_HEIGHT },
        };
      });
      return [...videoNodes, ...standaloneNodes];
    }

    const columns = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
    return graph.nodes.map((node, index) => {
      const saved = layoutById.get(node.id);
      return {
        id: node.id,
        type: "clip",
        data: node,
        position: saved ? { x: saved.x, y: saved.y } : {
          x: (index % columns) * 280,
          y: Math.floor(index / columns) * 190,
        },
        style: { width: saved?.width ?? DEFAULT_CLIP_WIDTH, height: saved?.height ?? DEFAULT_CLIP_HEIGHT },
      };
    });
  }, [graph.nodes, handleVideoResizeEnd, layoutById, mode, selectedClip?.id]);

  useEffect(() => {
    flowNodesRef.current = generatedFlowNodes;
    setFlowNodesState(generatedFlowNodes);
  }, [generatedFlowNodes]);

  const flowEdges = useMemo<Edge[]>(() => graph.edges.flatMap(edge => {
    if (mode === "video") {
      const source = clipById.get(edge.source);
      const target = clipById.get(edge.target);
      if (!source || !target) return [];
      // For each link between two notes, emit one Flow edge per
      // (sourceAnchor, targetAnchor) pair — multi-anchor notes appear in
      // every anchored video's container, and the link should connect ALL
      // appearances, not just the primary. Standalone notes (zero anchors)
      // pass through with no handle (they render as freestanding ClipNodes
      // with default Handles).
      const srcAppearances = source.anchors?.length
        ? source.anchors.map((a) => ({
            nodeId: `video:${a.channelId}:${a.videoId}`,
            handle: `${source.id}:${a.ordinal}`,
            key: `${a.ordinal}`,
          }))
        : [{ nodeId: source.id, handle: undefined as string | undefined, key: "0" }];
      const tgtAppearances = target.anchors?.length
        ? target.anchors.map((a) => ({
            nodeId: `video:${a.channelId}:${a.videoId}`,
            handle: `${target.id}:${a.ordinal}`,
            key: `${a.ordinal}`,
          }))
        : [{ nodeId: target.id, handle: undefined as string | undefined, key: "0" }];

      const out: Edge[] = [];
      for (const s of srcAppearances) {
        for (const t of tgtAppearances) {
          // Skip self-loops where both appearances live in the same node —
          // they'd render as tiny loop arcs that just add noise.
          if (s.nodeId === t.nodeId) continue;
          out.push({
            id: `${edge.id}:${s.key}->${t.key}`,
            source: s.nodeId,
            target: t.nodeId,
            sourceHandle: s.handle,
            targetHandle: t.handle,
            ...edgeStyles(edge),
          });
        }
      }
      return out;
    }

    return [{
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...edgeStyles(edge),
    }];
  }), [clipById, graph.edges, mode]);

  const loadFilters = async () => {
    try {
      const [configRes, tagsRes] = await Promise.all([
        apiRequest("GET", `/api/pipeline/config?t=${Date.now()}`),
        apiRequest("GET", `/api/clips/tags?t=${Date.now()}`),
      ]);
      const config = await configRes.json() as { channels?: Channel[] };
      const tags = await tagsRes.json() as { tags?: TagOption[] };
      setChannels(config.channels || []);
      setTagOptions(tags.tags || []);
    } catch {
      setChannels([]);
      setTagOptions([]);
    }
  };

  const loadGraph = async () => {
    setLoading(true);
    setError("");
    try {
      const [graphRes, layoutRes] = await Promise.all([
        apiRequest("GET", buildGraphUrl({ q: appliedQuery, channelId, tags: tagFilter, edgeTypes, limit })),
        mode === "arc"
          ? Promise.resolve(null)
          : apiRequest("GET", `/api/clips/graph/layout?mapKey=${encodeURIComponent(mapKey)}&t=${Date.now()}`),
      ]);
      const data = await graphRes.json() as GraphResponse;
      const layoutData = layoutRes ? await layoutRes.json() as { nodes?: LayoutNode[] } : { nodes: [] };
      setLayoutById(new Map((layoutData.nodes || []).map(node => [node.nodeId, node])));
      setGraph({
        nodes: data.nodes || [],
        edges: data.edges || [],
        stats: data.stats || {
          nodeCount: data.nodes?.length || 0,
          edgeCount: data.edges?.length || 0,
          tagCount: 0,
          manualEdgeCount: 0,
          sharedTagEdgeCount: 0,
          sameVideoEdgeCount: 0,
        },
      });
      setSelectedClip(null);
      setSelectedEdge(null);
    } catch (err: any) {
      setGraph({ nodes: [], edges: [], stats: {
        nodeCount: 0,
        edgeCount: 0,
        tagCount: 0,
        manualEdgeCount: 0,
        sharedTagEdgeCount: 0,
        sameVideoEdgeCount: 0,
      }});
      setError(err.message?.includes("404")
        ? "The graph API is not available yet. Restart the backend that adds GET /api/clips/graph."
        : err.message || "Failed to load clip graph");
      setSelectedEdge(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadFilters();
  }, []);

  useEffect(() => {
    loadGraph();
  }, [channelId, edgeTypesKey, limit, mapKey, tagFilterKey]);

  useEffect(() => {
    if (mode === "video") {
      setEdgeTypes(current => current.filter(edgeType => edgeType !== "same_video"));
    }
  }, [mode]);

  function toggleEdgeType(edgeType: string) {
    setEdgeTypes(current => current.includes(edgeType)
      ? current.filter(item => item !== edgeType)
      : [...current, edgeType]);
  }

  function openClipVideo(clip: GraphNodeData) {
    setDrawerVideo(clipToDrawerEntry(clip));
    setDrawerSeconds(clip.startSeconds);
    setDrawerOpen(true);
  }

  const resolveConnectionClip = (nodeId: string | null, handleId: string | null | undefined): GraphNodeData | undefined => {
    if (!nodeId) return undefined;
    if (mode === "video") {
      // Handle id is `${clipId}:${anchorOrdinal}` for video-container rows;
      // standalone notes pass no handle (the freestanding ClipNode uses
      // the bare node id as the clip id).
      if (!handleId) return clipById.get(nodeId);
      const colon = handleId.lastIndexOf(":");
      const clipKey = colon > 0 ? handleId.slice(0, colon) : handleId;
      return clipById.get(clipKey);
    }
    return clipById.get(nodeId);
  };

  const createManualLink = async (source: GraphNodeData, target: GraphNodeData) => {
    try {
      await apiRequest("POST", `/api/clips/${source.clipId}/links`, {
        toId: target.clipId,
        kind: linkKind,
        note: linkNote.trim() || null,
      });
      toast({ title: "Note link created", description: `${source.title} → ${target.title}` });
      setLinkSource(null);
      setLinkNote("");
      await loadGraph();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Link failed", description: error.message });
    }
  };

  const deleteManualEdge = async (edge: Edge | null) => {
    if (!edge) return;
    const graphEdge = edge.data as GraphEdgeData | undefined;
    if (!graphEdge || graphEdge.kind !== "manual" || !graphEdge.manualKind) return;
    try {
      await apiRequest("DELETE", `/api/clips/${graphEdge.source}/links/${graphEdge.target}/${graphEdge.manualKind}`);
      toast({ title: "Note link removed", description: graphEdge.label.replace("_", " ") });
      await loadGraph();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Remove link failed", description: error.message });
    }
  };

  const reconnectManualEdge = async (oldEdge: Edge, connection: Connection) => {
    const graphEdge = oldEdge.data as GraphEdgeData | undefined;
    const source = resolveConnectionClip(connection.source, connection.sourceHandle);
    const target = resolveConnectionClip(connection.target, connection.targetHandle);
    if (!graphEdge || graphEdge.kind !== "manual" || !graphEdge.manualKind || !source || !target || source.id === target.id) return;
    try {
      await apiRequest("DELETE", `/api/clips/${graphEdge.source}/links/${graphEdge.target}/${graphEdge.manualKind}`);
      await apiRequest("POST", `/api/clips/${source.clipId}/links`, {
        toId: target.clipId,
        kind: graphEdge.manualKind,
        note: graphEdge.note || null,
      });
      toast({ title: "Clip link reconnected" });
      await loadGraph();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Reconnect failed", description: error.message });
    }
  };

  const onNodeClick: NodeMouseHandler = async (_event, node) => {
    if (mode !== "clip") return;
    const clip = node.data as GraphNodeData;
    if (linkSource) {
      if (clip.id === linkSource.id) {
        setLinkSource(null);
        return;
      }
      await createManualLink(linkSource, clip);
      return;
    }
    setSelectedClip(clip);
  };

  // Double-click on a clip-mode or force-mode node opens the source video
  // drawer at the clip's start, matching the video-mode card behavior.
  // ReactFlow's video-mode nodes handle their own double-click on inner
  // clip cards (see VideoFlowNode), so this handler only fires for the
  // simpler clip/force-mode node shells.
  const onNodeDoubleClick: NodeMouseHandler = (_event, node) => {
    if (mode === "video") return;
    openClipVideo(node.data as GraphNodeData);
  };

  const onNodesChange = (changes: NodeChange[]) => {
    setFlowNodesState(nodes => {
      const next = applyNodeChanges(changes, nodes);
      flowNodesRef.current = next;
      return next;
    });
  };

  const onNodeDragStop: OnNodeDrag = (_event, node) => {
    const width = Number(node.width || node.style?.width || (mode === "video" ? DEFAULT_VIDEO_WIDTH : DEFAULT_CLIP_WIDTH));
    const height = Number(node.height || node.style?.height || (mode === "video" ? DEFAULT_VIDEO_HEIGHT : DEFAULT_CLIP_HEIGHT));
    void saveLayoutNodes([{ nodeId: node.id, x: node.position.x, y: node.position.y, width, height }]);
  };

  const onConnect = async (connection: Connection) => {
    const source = resolveConnectionClip(connection.source, connection.sourceHandle);
    const target = resolveConnectionClip(connection.target, connection.targetHandle);
    if (!source || !target || source.id === target.id) return;
    await createManualLink(source, target);
  };

  const onEdgeClick: EdgeMouseHandler = (event, edge) => {
    event.stopPropagation();
    setSelectedEdge(edge);
    const payload = edge.data as GraphEdgeData | undefined;
    if (payload?.source) setSelectedClip(clipById.get(payload.source) || null);
  };

  const refreshGraph = () => {
    const nextQuery = query.trim();
    if (nextQuery !== appliedQuery) {
      setAppliedQuery(nextQuery);
      return;
    }
    void loadGraph();
  };

  return (
    <div className="px-4 py-4 space-y-4">
      <Card>
        <CardHeader className="space-y-2">
          <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
            <CardTitle className="flex items-center gap-2">
              <MapIcon className="h-4 w-4" />
              Notes Map
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") refreshGraph(); }}
                  placeholder="Search notes"
                  className="h-9 w-full pl-8 sm:w-56"
                />
              </div>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  {channels.map(channel => <SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={String(limit)} onValueChange={value => setLimit(Number(value))}>
                <SelectTrigger className="h-9 w-[110px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="50">50 notes</SelectItem>
                  <SelectItem value="150">150 notes</SelectItem>
                  <SelectItem value="300">300 notes</SelectItem>
                  <SelectItem value="500">500 notes</SelectItem>
                </SelectContent>
              </Select>
              <TagPicker
                value={tagFilter}
                onChange={setTagFilter}
                options={tagOptions}
                size="sm"
                placeholder="Filter tags..."
                onOpen={loadFilters}
                className="min-w-[180px]"
              />
              <Button variant="outline" size="sm" className="h-9" onClick={refreshGraph} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            </div>
          </div>

          {/* Mode row: icon-labeled mode buttons + edge filter dropdown +
              compact stats. Mode tooltips explain what each mode is best for. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">View</div>
            <Button size="sm" variant={mode === "video" ? "default" : "outline"} onClick={() => setMode("video")} title="Notes grouped under each video they anchor">
              <LayoutGrid className="h-3.5 w-3.5" /> Videos
            </Button>
            <Button size="sm" variant={mode === "clip" ? "default" : "outline"} onClick={() => setMode("clip")} title="Notes as freestanding cards you can arrange freely">
              <StickyNote className="h-3.5 w-3.5" /> Cards
            </Button>
            <Button size="sm" variant={mode === "arc" ? "default" : "outline"} onClick={() => setMode("arc")} title="Notes in a vertical line with arcs showing links — good for spotting cross-cluster connections">
              <Spline className="h-3.5 w-3.5" /> Arc
            </Button>
            <Button size="sm" variant={mode === "force" ? "default" : "outline"} onClick={() => setMode("force")} title="Physics-driven layout that clusters tightly-linked notes — good for exploring groups">
              <Zap className="h-3.5 w-3.5" /> Cluster
            </Button>

            {mode === "arc" && (
              <Select value={arcOrder} onValueChange={value => setArcOrder(value as ArcOrder)}>
                <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tag">Order by tag</SelectItem>
                  <SelectItem value="date">Order by date</SelectItem>
                  <SelectItem value="channel">Order by channel</SelectItem>
                  <SelectItem value="title">Order by title</SelectItem>
                  <SelectItem value="connections">Order by links</SelectItem>
                </SelectContent>
              </Select>
            )}

            <div className="ml-auto flex items-center gap-2 text-xs">
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-8">
                    Edges
                    <ChevronDown className="ml-1 h-3 w-3" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-56 p-2" align="end">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Show which edges</div>
                  {(mode === "video" ? ["manual", "shared_tag"] : ["manual", "shared_tag", "same_video"]).map((edgeType) => {
                    const label = edgeType === "manual" ? "Your links"
                      : edgeType === "shared_tag" ? "Shared tags"
                      : "Same video";
                    const active = edgeTypes.includes(edgeType);
                    return (
                      <label key={edgeType} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-secondary">
                        <input
                          type="checkbox"
                          checked={active}
                          onChange={() => toggleEdgeType(edgeType)}
                          className="h-3.5 w-3.5"
                        />
                        <span>{label}</span>
                      </label>
                    );
                  })}
                </PopoverContent>
              </Popover>
              <span className="text-muted-foreground">{graph.stats.nodeCount} notes · {graph.stats.edgeCount} edges</span>
            </div>
          </div>

          {/* Active-mode hint — one line so users know what they're looking at. */}
          <div className="text-[11px] text-muted-foreground">
            {mode === "video" && "Each box is a video; rows inside are notes anchored at that moment. Multi-anchor notes appear in every video they touch."}
            {mode === "clip" && "Each card is a note. Drag to arrange. Drag the right dot of one card to the left dot of another to link them."}
            {mode === "arc" && "Notes ordered along a vertical line; arcs show how they connect. Order with the dropdown above."}
            {mode === "force" && "Tightly-linked notes pull together into clusters. Scroll to zoom, drag to pan."}
          </div>

          {/* Linking controls — only when a note is selected. Collapses when
              not linking so it stays out of the way most of the time. */}
          {selectedClip && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2 text-xs">
              <Button
                size="sm"
                variant={linkSource ? "default" : "outline"}
                onClick={() => setLinkSource(value => value ? null : selectedClip)}
              >
                {linkSource ? <X className="h-3.5 w-3.5" /> : <Link2 className="h-3.5 w-3.5" />}
                {linkSource ? "Cancel link" : `Link "${selectedClip.title.length > 24 ? selectedClip.title.slice(0, 24) + "…" : selectedClip.title}"`}
              </Button>
              {linkSource && (
                <>
                  <Select value={linkKind} onValueChange={value => setLinkKind(value as ClipLinkKind)}>
                    <SelectTrigger className="h-8 w-[150px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {LINK_KINDS.map(kind => <SelectItem key={kind.value} value={kind.value}>{kind.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <Input
                    value={linkNote}
                    onChange={event => setLinkNote(event.target.value)}
                    placeholder="Optional note about this link"
                    className="h-8 flex-1 min-w-[160px] text-xs"
                  />
                  <span className="text-muted-foreground">Click another note to connect.</span>
                </>
              )}
              {!linkSource && (
                <span className="text-muted-foreground">Selected: <span className="text-foreground">{selectedClip.title}</span></span>
              )}
            </div>
          )}

          {/* Selected-edge floating toolbar — appears when an edge is clicked.
              Compact, single-line. Delete only enabled for manual edges. */}
          {selectedEdge && (
            <div className="flex items-center justify-between rounded-md border border-primary/30 bg-primary/5 p-2 text-xs">
              <span>
                Selected edge: <span className="text-foreground">{(selectedEdge.data as GraphEdgeData | undefined)?.label?.replace("_", " ") || selectedEdge.id}</span>
              </span>
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                disabled={(selectedEdge.data as GraphEdgeData | undefined)?.kind !== "manual"}
                onClick={() => deleteManualEdge(selectedEdge)}
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Delete
              </Button>
            </div>
          )}
        </CardHeader>
      </Card>

      {error && (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="min-h-[calc(100vh-300px)] overflow-hidden">
          <CardContent className="h-[calc(100vh-300px)] min-h-[760px] p-0">
            {loading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading graph...
              </div>
            ) : graph.nodes.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
                No graph nodes to display. Add tags/links to clips, or loosen the filters.
              </div>
            ) : mode === "arc" ? (
              <ArcDiagram
                nodes={graph.nodes}
                edges={graph.edges}
                order={arcOrder}
                selectedId={selectedClip?.id || null}
                onSelect={setSelectedClip}
                onOpen={openClipVideo}
              />
            ) : mode === "force" ? (
              <ForceDiagram
                nodes={graph.nodes}
                edges={graph.edges}
                selectedId={selectedClip?.id || null}
                onSelect={setSelectedClip}
                onOpen={openClipVideo}
              />
            ) : (
              <ReactFlow
                nodes={flowNodesState}
                edges={flowEdges}
                nodeTypes={nodeTypes}
                onNodeClick={onNodeClick}
                onNodeDoubleClick={onNodeDoubleClick}
                onConnect={onConnect}
                onEdgeClick={onEdgeClick}
                onNodesChange={onNodesChange}
                onNodeDragStop={onNodeDragStop}
                onReconnectStart={(_event, edge) => {
                  reconnectSucceededRef.current = false;
                  reconnectEdgeRef.current = edge;
                }}
                onReconnect={async (oldEdge, connection) => {
                  reconnectSucceededRef.current = true;
                  await reconnectManualEdge(oldEdge, connection);
                }}
                onReconnectEnd={async (_event, edge, _handleType, connectionState: any) => {
                  if (!reconnectSucceededRef.current && !connectionState?.toNode) {
                    await deleteManualEdge(edge || reconnectEdgeRef.current);
                  }
                  reconnectEdgeRef.current = null;
                }}
                nodesDraggable
                panOnDrag
                connectOnClick={false}
                edgesReconnectable
                reconnectRadius={16}
                fitView
                minZoom={0.1}
                maxZoom={2.5}
              >
                <Background />
                <MiniMap pannable zoomable />
                <Controls />
              </ReactFlow>
            )}
          </CardContent>
        </Card>

        <ClipInspector
          clip={selectedClip}
          edges={selectedEdges}
          related={relatedClips}
          onOpenVideo={openClipVideo}
          onSelectClip={setSelectedClip}
        />
      </div>

      <VideoDrawer
        open={drawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
        onOpenChange={setDrawerOpen}
      />
    </div>
  );
}

function ArcDiagram({
  nodes,
  edges,
  order,
  selectedId,
  onSelect,
  onOpen,
}: {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  order: ArcOrder;
  selectedId: string | null;
  onSelect: (node: GraphNodeData) => void;
  onOpen?: (node: GraphNodeData) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const width = svgRef.current?.clientWidth || 960;
    const step = 34;
    const marginTop = 30;
    const marginRight = 34;
    const marginBottom = 34;
    const marginLeft = Math.min(360, Math.max(220, width * 0.34));
    const height = Math.max(svgRef.current?.clientHeight || 720, Math.max(1, nodes.length - 1) * step + marginTop + marginBottom);
    const degreeById = new Map<string, number>();
    for (const edge of edges) {
      degreeById.set(edge.source, (degreeById.get(edge.source) || 0) + 1);
      degreeById.set(edge.target, (degreeById.get(edge.target) || 0) + 1);
    }
    const compareDate = (a: GraphNodeData, b: GraphNodeData) => {
      const da = a.uploadDate || "";
      const db = b.uploadDate || "";
      if (da !== db) return da.localeCompare(db);
      return a.startSeconds - b.startSeconds;
    };
    const compareChannel = (a: GraphNodeData, b: GraphNodeData) => {
      const ca = a.channelName || a.channelId;
      const cb = b.channelName || b.channelId;
      if (ca !== cb) return ca.localeCompare(cb);
      return compareDate(a, b);
    };
    const compareTag = (a: GraphNodeData, b: GraphNodeData) => {
      const ta = primaryTag(a);
      const tb = primaryTag(b);
      if (ta !== tb) return ta.localeCompare(tb);
      return compareChannel(a, b);
    };
    const orderedNodes = [...nodes].sort((a, b) => {
      if (order === "date") return compareDate(a, b);
      if (order === "channel") return compareChannel(a, b);
      if (order === "title") return a.title.localeCompare(b.title) || compareDate(a, b);
      if (order === "connections") return (degreeById.get(b.id) || 0) - (degreeById.get(a.id) || 0) || compareTag(a, b);
      return compareTag(a, b);
    });
    const byId = new Map(orderedNodes.map(node => [node.id, node]));
    const y = d3.scalePoint<string>()
      .domain(orderedNodes.map(node => node.id))
      .range([marginTop, height - marginBottom])
      .padding(0.5);
    const maxDegree = d3.max(orderedNodes, node => node.degree) || 1;
    const radius = d3.scaleSqrt().domain([0, maxDegree]).range([4, 11]);
    const tags = Array.from(new Set(orderedNodes.flatMap(node => node.tags.length ? [primaryTag(node)] : ["untagged"]))).sort();
    const color = d3.scaleOrdinal<string, string>()
      .domain(tags)
      .range(d3.schemeTableau10.concat(d3.schemeSet3 as string[]))
      .unknown("#9ca3af");

    function primaryTag(node: GraphNodeData): string {
      return node.tags[0] || "untagged";
    }

    function sharedTag(edge: GraphEdgeData): string | null {
      if (edge.tags?.length) return edge.tags[0];
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) return null;
      const targetTags = new Set(target.tags);
      return source.tags.find(tag => targetTags.has(tag)) || null;
    }

    function arcPath(edge: GraphEdgeData): string {
      const y1 = y(edge.source) ?? marginTop;
      const y2 = y(edge.target) ?? marginTop;
      const distance = Math.abs(y2 - y1);
      const r = Math.max(18, distance / 2);
      const sweep = y1 < y2 ? 1 : 0;
      return `M${marginLeft},${y1}A${r},${r} 0,0,${sweep} ${marginLeft},${y2}`;
    }

    svg
      .attr("viewBox", `0 0 ${width} ${height}`)
      .attr("width", width)
      .attr("height", height);

    svg.append("line")
      .attr("x1", marginLeft)
      .attr("x2", marginLeft)
      .attr("y1", marginTop)
      .attr("y2", height - marginBottom)
      .attr("stroke", "currentColor")
      .attr("opacity", 0.18);

    const visibleEdges = edges.filter(edge => byId.has(edge.source) && byId.has(edge.target));
    const path = svg.insert("g", "*")
      .attr("fill", "none")
      .selectAll("path")
      .data(visibleEdges)
      .join("path")
        .attr("d", arcPath)
        .attr("class", edge => `arc-link ${edge.source === selectedId || edge.target === selectedId ? "selected" : ""}`)
        .attr("fill", "none")
        .attr("stroke", edge => {
          const tag = sharedTag(edge);
          return tag ? color(tag) : edgeColor(edge.kind);
        })
        .attr("stroke-width", edge => edge.kind === "manual" ? 2.25 : Math.max(1, Math.min(4, edge.weight)))
        .attr("stroke-opacity", edge => edge.source === selectedId || edge.target === selectedId ? 0.9 : 0.5);

    path.append("title").text(edge => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      const tag = sharedTag(edge);
      return `${edge.label}${tag ? ` (${tag})` : ""}: ${source?.title || edge.source} -> ${target?.title || edge.target}`;
    });

    const nodeGroup = svg.append("g");
    const label = nodeGroup.selectAll("g")
      .data(orderedNodes)
      .join("g")
      .attr("class", node => `arc-node ${node.id === selectedId ? "selected" : ""}`)
      .attr("transform", node => `translate(${marginLeft},${y(node.id)})`)
      .style("cursor", "pointer")
      .on("click", (_event, node) => onSelect(node))
      .on("dblclick", (event, node) => { event.stopPropagation(); onOpen?.(node); });

    label.append("text")
      .attr("x", -10)
      .attr("dy", "-0.15em")
      .attr("text-anchor", "end")
      .attr("font-size", 11)
      .attr("fill", node => d3.color(color(primaryTag(node)))?.darker(1.1).formatHex() || color(primaryTag(node)))
      .text(node => {
        const title = node.title.length > 42 ? `${node.title.slice(0, 42)}...` : node.title;
        return `${formatTimestamp(node.startSeconds)}  ${title}`;
      });

    label.append("text")
      .attr("x", -10)
      .attr("dy", "1.05em")
      .attr("text-anchor", "end")
      .attr("font-size", 9)
      .attr("fill", "currentColor")
      .attr("opacity", 0.55)
      .text(node => `${node.channelName || node.channelId} · ${primaryTag(node)}`);

    label.append("circle")
      .attr("r", node => radius(node.degree || 1))
      .attr("fill", node => color(primaryTag(node)))
      .attr("stroke", node => node.id === selectedId ? "currentColor" : "var(--color-background)")
      .attr("stroke-width", node => node.id === selectedId ? 3 : 1.5);

    label.append("rect")
      .attr("x", -marginLeft)
      .attr("y", -step / 2)
      .attr("width", marginLeft + 220)
      .attr("height", step)
      .attr("fill", "transparent")
      .attr("pointer-events", "all")
      .on("pointerenter", (_event, node) => {
        const connected = new Set<string>();
        for (const edge of visibleEdges) {
          if (edge.source === node.id) connected.add(edge.target);
          if (edge.target === node.id) connected.add(edge.source);
        }
        svg.classed("hovering", true);
        label.classed("primary", item => item.id === node.id);
        label.classed("secondary", item => connected.has(item.id));
        path.classed("primary", edge => edge.source === node.id || edge.target === node.id).filter(".primary").raise();
      })
      .on("pointerleave", () => {
        svg.classed("hovering", false);
        label.classed("primary", false);
        label.classed("secondary", false);
        path.classed("primary", false).order();
      });

    label.append("title")
      .text(node => `${node.title}\n${formatUploadDate(node.uploadDate)} ${formatTimestamp(node.startSeconds)}\n${node.quote}`);

    const legend = svg.append("g")
      .attr("transform", `translate(${Math.max(marginLeft + 42, width - marginRight - 210)},${marginTop})`);
    tags.slice(0, 12).forEach((tag, index) => {
      const row = legend.append("g").attr("transform", `translate(0,${index * 18})`);
      row.append("circle").attr("r", 4).attr("fill", color(tag));
      row.append("text")
        .attr("x", 10)
        .attr("dy", "0.35em")
        .attr("font-size", 10)
        .attr("fill", "currentColor")
        .text(tag.length > 26 ? `${tag.slice(0, 26)}...` : tag);
    });

    svg.append("style").text(`
      .hovering .arc-node text { opacity: 0.34; }
      .hovering .arc-node circle { opacity: 0.32; }
      .hovering .arc-node.primary text,
      .hovering .arc-node.secondary text { opacity: 1; }
      .hovering .arc-node.primary text { font-weight: 700; }
      .hovering .arc-node.primary circle,
      .hovering .arc-node.secondary circle { opacity: 1; }
      .hovering .arc-link { stroke-opacity: 0.14; }
      .hovering .arc-link.primary { stroke-opacity: 0.95; stroke-width: 3; }
      .arc-link.selected { stroke-opacity: 0.95; stroke-width: 3; }
    `);
  }, [edges, nodes, onOpen, onSelect, order, selectedId]);

  return (
    <div className="h-full w-full overflow-auto">
      <svg ref={svgRef} className="min-h-full w-full text-foreground" />
    </div>
  );
}

function ForceDiagram({
  nodes,
  edges,
  selectedId,
  onSelect,
  onOpen,
}: {
  nodes: GraphNodeData[];
  edges: GraphEdgeData[];
  selectedId: string | null;
  onSelect: (node: GraphNodeData | null) => void;
  onOpen?: (node: GraphNodeData) => void;
}) {
  type ForceNode = NodeObject<{
    clip: GraphNodeData;
    group: string;
    color: string;
    label: string;
    val: number;
  }>;
  type ForceLink = LinkObject<ForceNode, {
    edge: GraphEdgeData;
    color: string;
    width: number;
    label: string;
  }>;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<ForceGraphMethods<ForceNode, ForceLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 960, height: 760 });
  const [hoverNodeId, setHoverNodeId] = useState<string | null>(null);
  const didFitRef = useRef(false);

  // Resize: recompute width/height only. Never reheat the simulation here —
  // the previous version restarted the layout on every panel resize, which
  // is the main reason it felt clunky.
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(420, Math.floor(rect.height)),
      });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Read theme on every paint — cheap classList read avoids stale state.
  function pickThemeColors() {
    const isDark = typeof document !== "undefined"
      && document.documentElement.classList.contains("dark");
    return {
      fg: isDark ? "rgba(245,245,245,0.95)" : "rgba(20,20,20,0.95)",
      muted: isDark ? "rgba(170,170,170,0.85)" : "rgba(80,80,80,0.85)",
      nodeStroke: isDark ? "rgba(20,20,20,0.85)" : "rgba(255,255,255,0.9)",
    };
  }

  const graphData = useMemo(() => {
    const tags = Array.from(new Set(nodes.map(primaryTag))).sort();
    const color = d3.scaleOrdinal<string, string>()
      .domain(tags)
      .range(d3.schemeTableau10.concat(d3.schemeSet2 as string[]))
      .unknown("#9ca3af");
    const maxDegree = d3.max(nodes, node => node.degree) || 1;
    const val = d3.scaleSqrt().domain([0, maxDegree]).range([3.5, 8]);
    const nodeIds = new Set(nodes.map(node => node.id));
    const graphNodes: ForceNode[] = nodes.map(node => {
      const group = primaryTag(node);
      return {
        id: node.id,
          clip: node,
          group,
          color: color(group),
          label: `${node.title}\n${group}\n${formatTimestamp(node.startSeconds)} - ${formatTimestamp(node.endSeconds)}`,
          val: val(node.degree || 1),
      };
    });

    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const sharedTag = (edge: GraphEdgeData): string | null => {
      if (edge.tags?.length) return edge.tags[0];
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (!source || !target) return null;
      const targetTags = new Set(target.tags);
      return source.tags.find(tag => targetTags.has(tag)) || null;
    };

    const graphLinks: ForceLink[] = edges
      .filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target))
      .map(edge => {
        const tag = sharedTag(edge);
        return {
          source: edge.source,
          target: edge.target,
          edge,
          color: edge.kind === "manual" ? "rgba(100,116,139,0.68)" : tag ? color(tag) : "rgba(148,163,184,0.45)",
          width: edge.kind === "manual" ? 1.4 : Math.max(0.5, Math.min(1.5, edge.weight * 0.45)),
          label: `${edge.label}${tag ? ` (${tag})` : ""}`,
        };
      });

    return {
      data: { nodes: graphNodes, links: graphLinks },
    };
  }, [edges, nodes]);

  function endpointId(value: unknown): string {
    if (value && typeof value === "object" && "id" in value) return String((value as { id: string | number }).id);
    return String(value);
  }

  const connectedIds = useMemo(() => {
    const focusId = hoverNodeId || selectedId;
    const connected = new Set<string>();
    if (!focusId) return connected;
    for (const link of graphData.data.links) {
      const source = endpointId(link.source);
      const target = endpointId(link.target);
      if (source === focusId) connected.add(target);
      if (target === focusId) connected.add(source);
    }
    return connected;
  }, [graphData.data.links, hoverNodeId, selectedId]);

  // Reset the one-shot fit-to-view flag whenever the underlying graph
  // changes (filter applied, new clip created, etc.).
  useEffect(() => {
    didFitRef.current = false;
  }, [graphData]);

  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const charge = graph.d3Force("charge") as any;
    charge?.strength?.(-160);
    charge?.distanceMax?.(500);

    const linkForce = graph.d3Force("link") as any;
    linkForce?.distance?.((link: ForceLink) => link.edge.kind === "manual" ? 100 : 75);
    linkForce?.strength?.((link: ForceLink) => link.edge.kind === "manual" ? 0.55 : 0.25);

    // Without these, the d3 default `center` force only re-centers the
    // centroid — individual nodes still drift outward forever from charge
    // repulsion. Weak forceX/Y at origin keeps the cloud bounded without
    // fighting the layout.
    graph.d3Force("x", d3.forceX<ForceNode>(0).strength(0.045) as any);
    graph.d3Force("y", d3.forceY<ForceNode>(0).strength(0.045) as any);
    graph.d3Force(
      "collide",
      d3.forceCollide<ForceNode>(node => Number(node.val || 5) + 4).strength(0.7) as any,
    );

    graph.d3ReheatSimulation();
  }, [graphData]);

  function drawNode(node: ForceNode, ctx: CanvasRenderingContext2D, globalScale: number) {
    const clip = node.clip as GraphNodeData;
    const x = node.x || 0;
    const y = node.y || 0;
    const radius = Math.max(3.5, Number(node.val || 5));
    const isFocus = clip.id === selectedId || clip.id === hoverNodeId;
    const isConnected = connectedIds.has(clip.id);
    const dim = !!(hoverNodeId || selectedId) && !isFocus && !isConnected;
    const colors = pickThemeColors();

    ctx.globalAlpha = dim ? 0.16 : 1;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = String(node.color || "#9ca3af");
    ctx.fill();
    ctx.lineWidth = isFocus ? 2.4 / globalScale : 1.1 / globalScale;
    ctx.strokeStyle = isFocus ? colors.fg : colors.nodeStroke;
    ctx.stroke();

    // Render text only when it's worth reading: hovered/selected, the user
    // has zoomed in, or the node is a hub. Massive perf win and the chart
    // stops looking like a wall of text.
    const showLabel = isFocus || isConnected || globalScale > 1.45;
    if (showLabel) {
      const label = clip.title.length > 38 ? `${clip.title.slice(0, 38)}...` : clip.title;
      const fontSize = Math.max(8, 11 / globalScale);
      ctx.font = `${isFocus ? 700 : 500} ${fontSize}px sans-serif`;
      ctx.fillStyle = isFocus ? colors.fg : colors.muted;
      ctx.fillText(label, x + radius + 4, y + fontSize / 3);
    }

    ctx.globalAlpha = 1;
  }

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden bg-background">
      <ForceGraph2D<ForceNode, ForceLink>
        ref={graphRef}
        width={size.width}
        height={size.height}
        graphData={graphData.data}
        backgroundColor="rgba(0,0,0,0)"
        nodeId="id"
        nodeVal="val"
        nodeColor="color"
        nodeRelSize={1}
        nodeLabel={node => String(node.label || "")}
        nodeCanvasObject={drawNode}
        nodePointerAreaPaint={(node, color, ctx) => {
          const radius = Math.max(10, Number(node.val || 6) + 6);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x || 0, node.y || 0, radius, 0, Math.PI * 2);
          ctx.fill();
        }}
        linkColor={link => {
          const focused = hoverNodeId || selectedId;
          const baseColor = String(link.color || "#9ca3af");
          if (!focused) return baseColor;
          const source = endpointId(link.source);
          const target = endpointId(link.target);
          // Dim non-focus links by COLOR (alpha), not width — shrinking width
          // made them invisible the moment a node was clicked.
          return source === focused || target === focused ? baseColor : "rgba(148,163,184,0.18)";
        }}
        linkWidth={link => {
          const focused = hoverNodeId || selectedId;
          const base = Math.max(0.9, Number(link.width || 1));
          if (!focused) return base;
          const source = endpointId(link.source);
          const target = endpointId(link.target);
          return source === focused || target === focused ? base * 1.6 : base;
        }}
        linkLabel={link => String(link.label || "")}
        linkCurvature={0.02}
        linkDirectionalParticles={0}
        linkHoverPrecision={5}
        d3AlphaDecay={0.018}
        d3VelocityDecay={0.36}
        cooldownTicks={220}
        onNodeClick={node => {
          const clip = node.clip as GraphNodeData;
          // Force-mode dots have no real "selected" affordance, so a
          // single click both selects (inspector updates) and opens the
          // source video drawer. Click background to clear.
          onSelect(clip);
          onOpen?.(clip);
        }}
        onBackgroundClick={() => onSelect(null)}
        onNodeHover={(node) => setHoverNodeId(node ? String(node.id) : null)}
        onNodeDragEnd={(node) => {
          node.fx = undefined;
          node.fy = undefined;
        }}
        onEngineStop={() => {
          if (didFitRef.current) return;
          didFitRef.current = true;
          const graph = graphRef.current;
          if (!graph) return;
          graph.zoomToFit(420, 80);
          // Cap zoom for tiny graphs so 2 nodes don't fill the screen.
          window.setTimeout(() => {
            const z = graph.zoom();
            if (z > 1.4) graph.zoom(1.4, 250);
          }, 460);
        }}
      />

      <div className="absolute right-3 top-3 flex flex-col gap-1.5">
        <button
          type="button"
          onClick={() => graphRef.current?.zoomToFit(400, 60)}
          className="rounded-md border bg-background/85 px-2 py-1 text-xs shadow-sm backdrop-blur hover:bg-accent"
          title="Fit all nodes back into view"
        >
          Re-center
        </button>
        <button
          type="button"
          onClick={() => graphRef.current?.d3ReheatSimulation()}
          className="rounded-md border bg-background/85 px-2 py-1 text-xs shadow-sm backdrop-blur hover:bg-accent"
          title="Re-run the layout"
        >
          Reflow
        </button>
      </div>

      <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border bg-background/85 px-2 py-1 text-[11px] shadow-sm backdrop-blur">
        Hover to focus · Click to inspect · Drag to move
      </div>
    </div>
  );
}

function ClipInspector({
  clip,
  edges,
  related,
  onOpenVideo,
  onSelectClip,
}: {
  clip: GraphNodeData | null;
  edges: GraphEdgeData[];
  related: GraphNodeData[];
  onOpenVideo: (clip: GraphNodeData) => void;
  onSelectClip: (clip: GraphNodeData) => void;
}) {
  if (!clip) {
    return (
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="h-4 w-4" />
            Inspector
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Select a clip row to inspect the quote, tags, and relationships.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-fit">
      <CardHeader>
        <CardTitle className="line-clamp-2 text-base">{clip.title}</CardTitle>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{clip.channelName || clip.channelId}</span>
          <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3" />{formatUploadDate(clip.uploadDate)}</span>
          <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{formatTimestamp(clip.startSeconds)} - {formatTimestamp(clip.endSeconds)}</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm leading-6">{clip.quote}</p>
        {clip.note && <p className="rounded-md border bg-muted/50 p-2 text-sm text-muted-foreground">{clip.note}</p>}
        {!!clip.tags.length && (
          <div className="flex flex-wrap gap-1.5">
            {clip.tags.map(tag => <TagChip key={tag} tag={tag} variant="outline" />)}
          </div>
        )}
        <Button size="sm" disabled={!clip.videoPath} onClick={() => onOpenVideo(clip)}>
          <Play className="h-3.5 w-3.5" />
          Open Video
        </Button>

        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm font-medium">
            <span>Relationships</span>
            <Badge variant="outline">{edges.length}</Badge>
          </div>
          <div className="divide-y rounded-md border">
            {edges.map(edge => (
              <div key={edge.id} className="p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={edge.kind === "manual" ? "default" : "outline"}>{edge.label.replace("_", " ")}</Badge>
                  <span className="text-muted-foreground">weight {edge.weight}</span>
                </div>
                {edge.note && <p className="mt-1 text-muted-foreground">{edge.note}</p>}
                {!!edge.tags?.length && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {edge.tags.map(tag => <TagChip key={tag} tag={tag} variant="outline" />)}
                  </div>
                )}
              </div>
            ))}
            {!edges.length && <p className="p-2 text-xs text-muted-foreground">No relationships in this working set.</p>}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Connected Clips</div>
          <div className="divide-y rounded-md border">
            {related.map(node => (
              <button
                key={node.id}
                type="button"
                className="block w-full p-2 text-left text-xs hover:bg-accent"
                onClick={() => onSelectClip(node)}
              >
                <span className="line-clamp-1 font-medium">{node.title}</span>
                <span className="text-muted-foreground">{node.channelName || node.channelId} - {formatTimestamp(node.startSeconds)}</span>
              </button>
            ))}
            {!related.length && <p className="p-2 text-xs text-muted-foreground">No connected clips.</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
