import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MiniMap,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TagPicker } from "@/components/TagPicker";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { apiRequest } from "@/lib/queryClient";
import { ChevronDown, LayoutGrid, Link2, Loader2, Map as MapIcon, RefreshCw, Search, Spline, StickyNote, Trash2, X, Zap } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { ArcDiagram } from "./map/ArcDiagram";
import { ClipInspector } from "./map/ClipInspector";
import { ClipNode } from "./map/ClipNode";
import { ForceDiagram } from "./map/ForceDiagram";
import { VideoNode } from "./map/VideoNode";
import { buildGraphUrl, clipToDrawerEntry, edgeStyles, makeMapKey, videoNodeId } from "./map/helpers";
import {
  DEFAULT_CLIP_HEIGHT,
  DEFAULT_CLIP_WIDTH,
  DEFAULT_VIDEO_HEIGHT,
  DEFAULT_VIDEO_WIDTH,
  LINK_KINDS,
  type ArcOrder,
  type Channel,
  type ClipLinkKind,
  type GraphEdgeData,
  type GraphNodeData,
  type GraphResponse,
  type LayoutMode,
  type LayoutNode,
  type TagOption,
  type VideoNodeData,
} from "./map/types";

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
