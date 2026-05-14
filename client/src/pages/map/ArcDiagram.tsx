import { useEffect, useRef } from "react";
import * as d3 from "d3";
import { edgeColor, formatTimestamp, formatUploadDate, primaryTag } from "./helpers";
import type { ArcOrder, GraphEdgeData, GraphNodeData } from "./types";

/**
 * The "Arc" layout — notes laid out along a vertical axis with arcs
 * connecting linked notes. Sorting by tag/date/channel/title/connections
 * surfaces different cross-cluster patterns. d3-driven SVG.
 */
export function ArcDiagram({
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
          // Manual links are visually meaningful per-kind (Same Topic,
          // Contradicts, etc.) — use the kind color even when there's a
          // shared tag. Auto-generated shared_tag edges still color by
          // tag so the arc clusters by category.
          if (edge.kind === "manual") return edgeColor(edge.kind, edge.manualKind);
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
