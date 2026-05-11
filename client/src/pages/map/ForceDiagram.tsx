import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import ForceGraph2D, { type ForceGraphMethods, type LinkObject, type NodeObject } from "react-force-graph-2d";
import { formatTimestamp, primaryTag } from "./helpers";
import type { GraphEdgeData, GraphNodeData } from "./types";

/**
 * Physics-driven cluster layout via react-force-graph-2d. Tight links
 * pull nodes together; weak forceX/Y at origin keeps the cloud from
 * drifting forever under charge repulsion.
 */
export function ForceDiagram({
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
