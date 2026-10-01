import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  ConnectionMode,
  MarkerType,
  applyNodeChanges,
  type Connection,
  type Edge,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3";
import "@xyflow/react/dist/style.css";
import {
  LayoutGrid,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Search,
  StickyNote,
  X,
} from "lucide-react";
import { api } from "../lib/ipc.ts";
import { clock, count } from "../lib/format.ts";
import type { MapPosition, NoteAnchor, Research } from "../lib/types.ts";
import { anchorsOf, inCategory, LINK_KINDS } from "../notes/model.ts";
import { Markdown } from "../documents/Markdown.tsx";
import { Button, IconButton } from "../ui/Button.tsx";
import { Empty } from "../ui/Empty.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { Select } from "../ui/Select.tsx";
import { Segmented } from "../ui/Segmented.tsx";
import { useToast } from "../ui/Toasts.tsx";
import { useApp } from "../shell/AppContext.tsx";
import { MapNode, ArcEdge, type ItemNode } from "./MapNodes.tsx";
import { LinkEditor, type LinkDraft } from "./LinkEditor.tsx";
import {
  arcSort,
  COLORS,
  endpoint,
  filterNotes,
  graphLinks,
  mapItems,
  readHandle,
  savedPosition,
  viewKey,
  type Layout,
  type MapFilter,
  type ArcOrder,
  type ConnectionKind,
  type GraphLink,
  type Side,
} from "./model.ts";
import "./map.css";
const nodeTypes = { item: MapNode },
  edgeTypes = { arc: ArcEdge };
const blank: Research = {
  notes: [],
  links: [],
  docs: [],
  positions: [],
  tags: [],
};
export function MapPage() {
  const { revision, refresh, openNote, navigate, category } = useApp(),
    toast = useToast();
  const [data, setData] = useState<Research>(),
    [mode, setMode] = useState<Layout>("videos"),
    [order, setOrder] = useState<ArcOrder>("tag"),
    [filter, setFilter] = useState<MapFilter>({
      query: "",
      collection: "",
      tags: [],
      limit: 150,
    });
  const [kinds, setKinds] = useState<ConnectionKind[]>(["manual"]),
    [selected, setSelected] = useState<string>(),
    [draft, setDraft] = useState<LinkDraft>(),
    [nodes, setNodes] = useState<ItemNode[]>([]),
    [loading, setLoading] = useState(false);
  const flow = useRef<ReactFlowInstance<ItemNode, Edge> | null>(null),
    loadedView = useRef("");
  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .research()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(toast.error)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [revision, toast]);
  const research = data || blank;
  const notes = useMemo(
    () => filterNotes(research.notes.filter(n => inCategory(n, category)), filter),
    [research.notes, filter, category],
  );
  const links = useMemo(
    () => graphLinks(notes, research.links, kinds),
    [notes, research.links, kinds],
  );
  const sorted = useMemo(
    () => (mode === "arc" ? arcSort(notes, order, links) : notes),
    [notes, order, mode, links],
  );
  const items = useMemo(() => mapItems(sorted, mode), [sorted, mode]);
  const view = useMemo(
    () => viewKey(mode, { ...filter, category }, order),
    [mode, filter, order, category],
  );
  const selectedNote = notes.find((n) => n.id === selected);
  const openSource = useCallback(
    (a: NoteAnchor) => {
      if (a.media_id)
        navigate({ page: "recording", id: a.media_id, at: a.start || 0 });
      else if (a.doc_id) navigate({ page: "documents", id: a.doc_id });
    },
    [navigate],
  );
  const savePositions = useCallback(
    async (changes: Omit<MapPosition, "view">[]) => {
      try {
        await api.saveMapLayout(view, changes);
        setData((d) =>
          d
            ? {
                ...d,
                positions: [
                  ...(d.positions || []).filter(
                    (p) =>
                      p.view !== view ||
                      !changes.some((n) => n.node === p.node),
                  ),
                  ...changes.map((n) => ({ ...n, view })),
                ],
              }
            : d,
        );
      } catch (e) {
        toast.error(e);
      }
    },
    [view, toast],
  );
  const resized = useCallback(
    (id: string, width: number, height: number, x: number, y: number) => {
      void savePositions([{ node: id, x, y, width, height }]);
    },
    [savePositions],
  );
  const positions = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    if (mode === "cluster") {
      type Point = SimulationNodeDatum & { id: string };
      const points: Point[] = items.map((i) => ({ id: i.id }));
      const byNote = new Map(notes.map((n) => [n.id!, n]));
      const edges: SimulationLinkDatum<Point>[] = links.map((l) => ({
        source: endpoint(byNote.get(l.source)!, "", "right", mode).node,
        target: endpoint(byNote.get(l.target)!, "", "left", mode).node,
      }));
      const sim = forceSimulation(points)
        .force(
          "link",
          forceLink<Point, SimulationLinkDatum<Point>>(edges)
            .id((p) => p.id)
            .distance(330),
        )
        .force("charge", forceManyBody().strength(-750))
        .force("collide", forceCollide(155))
        .force("center", forceCenter(400, 300))
        .stop();
      sim.tick(180);
      for (const p of points) positions.set(p.id, { x: p.x || 0, y: p.y || 0 });
    } else
      items.forEach((item, i) =>
        positions.set(
          item.id,
          mode === "arc"
            ? { x: i * 310, y: Math.max(240, items.length * 35) }
            : { x: (i % 3) * 380, y: Math.floor(i / 3) * 400 },
        ),
      );
    return positions;
  }, [items, links, notes, mode]);
  useEffect(() => {
    const changed = loadedView.current !== view;
    loadedView.current = view;
    setNodes((previous) =>
      items.map((item) => {
        const old = !changed
          ? previous.find((n) => n.id === item.id)
          : undefined;
        const saved = savedPosition(research.positions || [], view, item.id);
        const position = old?.position ||
          saved ||
          positions.get(item.id) || { x: 0, y: 0 };
        const width = old?.width || saved?.width || (item.compact ? 260 : 340);
        const height = old?.height || saved?.height;
        return {
          id: item.id,
          type: "item",
          position: { x: position.x, y: position.y },
          width,
          ...(height ? { height } : {}),
          style: { width, ...(height ? { height } : {}) },
          data: {
            ...item,
            selectedNote: selected,
            select: setSelected,
            open: openNote,
            source: openSource,
            resized,
          },
        };
      }),
    );
    if (changed)
      window.setTimeout(
        () => flow.current?.fitView({ padding: 0.15, duration: 200 }),
        80,
      );
  }, [
    items,
    view,
    research.positions,
    positions,
    selected,
    openNote,
    openSource,
    resized,
  ]);
  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(notes.map((n) => [n.id!, n]));
    return links.flatMap((g) => {
      const source = byId.get(g.source),
        target = byId.get(g.target);
      if (!source || !target) return [];
      const a = endpoint(
          source,
          g.link?.source_anchor,
          (mode === "arc" ? "top" : g.link?.source_handle || "right") as Side,
          mode,
        ),
        b = endpoint(
          target,
          g.link?.target_anchor,
          (mode === "arc" ? "top" : g.link?.target_handle || "left") as Side,
          mode,
        );
      const color = g.link
        ? COLORS[g.link.kind] || "var(--primary)"
        : "var(--muted-foreground)";
      return [
        {
          id: g.id,
          source: a.node,
          target: b.node,
          sourceHandle: a.handle,
          targetHandle: b.handle,
          type: mode === "arc" ? "arc" : "default",
          label:
            g.kind === "manual"
              ? LINK_KINDS.find((k) => k.value === g.link?.kind)?.label ||
                g.label
              : undefined,
          data: { graph: g },
          reconnectable: g.kind === "manual",
          style: {
            stroke: color,
            strokeWidth: g.kind === "manual" ? 2.5 : 1.3,
            opacity: g.kind === "manual" ? 1 : 0.4,
            strokeDasharray: g.kind === "manual" ? undefined : "5 5",
          },
          labelStyle: { fill: "var(--foreground)", fontSize: 11 },
          labelBgStyle: { fill: "var(--popover)" },
          labelBgPadding: [6, 4] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd:
            g.link && ["follow_up", "context"].includes(g.link.kind)
              ? { type: MarkerType.ArrowClosed, color }
              : undefined,
        },
      ];
    });
  }, [notes, links, mode]);
  const connect = (c: Connection, previous?: GraphLink) => {
    const from = readHandle(c.sourceHandle),
      to = readHandle(c.targetHandle);
    if (!from || !to || from.note === to.note) return;
    const next = {
      ...(previous?.link || {}),
      source: from.note,
      target: to.note,
      kind: previous?.link?.kind || "same_topic",
      source_anchor: from.anchor,
      target_anchor: to.anchor,
      source_handle: from.side,
      target_handle: to.side,
    };
    setDraft({ next, previous: previous?.link });
  };
  const reset = () => {
    const changes = items.map((item) => ({
      node: item.id,
      ...positions.get(item.id)!,
      width: item.compact ? 260 : 340,
      height: item.compact
        ? 115
        : Math.min(600, Math.max(220, 100 + item.entries.length * 140)),
    }));
    setNodes((prev) =>
      prev.map((n) => {
        const p = changes.find((p) => p.node === n.id)!;
        return {
          ...n,
          position: { x: p.x, y: p.y },
          width: p.width,
          height: p.height,
          style: { width: p.width, height: p.height },
        };
      }),
    );
    void savePositions(changes);
    window.setTimeout(
      () => flow.current?.fitView({ padding: 0.15, duration: 200 }),
      100,
    );
  };
  const newLink = () =>
    setDraft({
      next: {
        source: selected || notes[0]?.id || "",
        target:
          notes.find((n) => n.id !== (selected || notes[0]?.id))?.id || "",
        kind: "same_topic",
        note: "",
      },
    });
  const tagOptions = research.tags?.map((t) => t.tag) || [
    ...new Set(research.notes.flatMap((n) => n.tags || [])),
  ];
  const collections = [
    ...new Set(
      research.notes.flatMap((n) =>
        anchorsOf(n).flatMap((a) => (a.channel ? [a.channel] : [])),
      ),
    ),
  ].sort();
  return (
    <div className="map-page">
      <PageHeader
        title="Map"
        meta={`${count(notes.length, "note")} · ${count(links.length, "connection")}${loading ? " · Loading…" : ""}`}
        actions={
          <>
            <Button size="sm" icon={RefreshCw} onClick={refresh}>
              Refresh
            </Button>
            <Button
              icon={Plus}
              variant="primary"
              onClick={() => openNote({ title: "", body: "" })}
            >
              New note
            </Button>
          </>
        }
      />
      <section className="map-toolbar">
        <div className="map-filters">
          <label className="search-field">
            <Search size={15} />
            <input
              type="search"
              maxLength={200}
              aria-label="Search map notes"
              placeholder="Search notes and evidence…"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
            />
          </label>
          <Select
            label="Map collection"
            value={filter.collection}
            onChange={(collection) => setFilter({ ...filter, collection })}
            options={[
              { value: "", label: "All collections" },
              ...collections.map((c) => ({ value: c, label: c })),
            ]}
          />
          <Select
            label="Map note limit"
            value={String(filter.limit)}
            onChange={(limit) => setFilter({ ...filter, limit: Number(limit) })}
            options={[50, 150, 300, 500].map((n) => ({
              value: String(n),
              label: `${n} notes`,
            }))}
          />
          <Select
            label="Add map tag filter"
            value=""
            onChange={(tag) =>
              tag &&
              filter.tags.length < 20 &&
              setFilter({
                ...filter,
                tags: [...new Set([...filter.tags, tag])],
              })
            }
            options={[
              { value: "", label: "Filter tags…" },
              ...tagOptions
                .filter((t) => !filter.tags.includes(t))
                .map((t) => ({ value: t, label: t })),
            ]}
          />
        </div>
        {!!filter.tags.length && (
          <div className="map-tag-filters">
            {filter.tags.map((t) => (
              <button
                key={t}
                onClick={() =>
                  setFilter({
                    ...filter,
                    tags: filter.tags.filter((x) => x !== t),
                  })
                }
              >
                {t}
                <X size={12} />
              </button>
            ))}
          </div>
        )}
        <div className="map-layout-controls">
          <Segmented
            label="Map layout"
            value={mode}
            onChange={setMode}
            options={[
              { value: "videos", label: "Videos", icon: LayoutGrid },
              { value: "cards", label: "Cards", icon: StickyNote },
              { value: "arc", label: "Arc" },
              { value: "cluster", label: "Cluster", icon: Network },
            ]}
          />
          {mode === "arc" && (
            <Select
              label="Arc order"
              value={order}
              onChange={setOrder}
              options={[
                { value: "tag", label: "By tag" },
                { value: "date", label: "By date" },
                { value: "collection", label: "By collection" },
                { value: "title", label: "By title" },
                { value: "connections", label: "By connections" },
              ]}
            />
          )}
          <details className="map-edge-filters">
            <summary>Connections</summary>
            <div>
              {(
                [
                  { value: "manual", label: "Typed connections" },
                  { value: "shared_tag", label: "Shared tags" },
                  { value: "same_recording", label: "Same recording" },
                ] as const
              ).map((k) => (
                <label key={k.value}>
                  <input
                    type="checkbox"
                    checked={kinds.includes(k.value)}
                    onChange={(e) =>
                      setKinds(
                        e.target.checked
                          ? [...kinds, k.value]
                          : kinds.filter((v) => v !== k.value),
                      )
                    }
                  />
                  {k.label}
                </label>
              ))}
            </div>
          </details>
          <Button
            size="sm"
            icon={Link2}
            disabled={notes.length < 2}
            onClick={newLink}
          >
            Connect notes
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!notes.length}
            onClick={reset}
          >
            Reset layout
          </Button>
        </div>
        <p>
          {mode === "videos"
            ? "Each box is a recording; its rows are notes anchored to that moment. Multi-source notes appear in each recording they reference."
            : mode === "arc"
              ? "Order notes to see how connections cross topics, dates, and collections."
              : mode === "cluster"
                ? "Connected notes gather together. Drag a note to refine the layout; positions are saved."
                : "Each card is a note with its evidence and tags. Drag a handle to connect notes or individual passages."}
        </p>
      </section>
      {notes.length ? (
        <div
          className={`map-workspace ${selectedNote ? "with-inspector" : ""}`}
        >
          <div className="map-flow-canvas" aria-label={`${mode} research map`}>
            <ReactFlow<ItemNode, Edge>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onInit={(instance) => {
                flow.current = instance;
              }}
              onNodesChange={(changes: NodeChange<ItemNode>[]) =>
                setNodes((n) => applyNodeChanges(changes, n))
              }
              onNodeClick={(_, node) =>
                setSelected(node.data.entries[0].note.id)
              }
              onNodeDragStop={(_, node) =>
                void savePositions([
                  {
                    node: node.id,
                    x: node.position.x,
                    y: node.position.y,
                    width: node.width,
                    height: node.height,
                  },
                ])
              }
              onConnect={connect}
              onReconnect={(edge, connection) =>
                connect(connection, edge.data?.graph as GraphLink)
              }
              onEdgeClick={(_, edge) => {
                const g = edge.data?.graph as GraphLink;
                if (g.link) setDraft({ next: g.link, previous: g.link });
                else toast.info(g.label);
              }}
              connectionMode={ConnectionMode.Loose}
              isValidConnection={(c) => {
                const a = readHandle(c.sourceHandle),
                  b = readHandle(c.targetHandle);
                return !!a && !!b && a.note !== b.note;
              }}
              nodesDraggable={mode !== "arc"}
              deleteKeyCode={null}
              minZoom={0.08}
              maxZoom={2}
              fitView
              fitViewOptions={{ padding: 0.15 }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--border)" gap={24} />
              <Controls />
              <MiniMap
                pannable
                zoomable
                nodeColor="var(--muted)"
                maskColor="color-mix(in oklab,var(--background) 80%,transparent)"
              />
            </ReactFlow>
          </div>
          {selectedNote && (
            <aside className="map-inspector" aria-label="Map note inspector">
              <header>
                <h2>{selectedNote.title}</h2>
                <IconButton
                  icon={X}
                  label="Close note inspector"
                  onClick={() => setSelected(undefined)}
                />
              </header>
              <div className="map-inspector-actions">
                <Button size="sm" onClick={() => openNote(selectedNote)}>
                  Edit note
                </Button>
                <Button
                  size="sm"
                  icon={Link2}
                  disabled={notes.length < 2}
                  onClick={newLink}
                >
                  Connect
                </Button>
              </div>
              {selectedNote.body && <Markdown source={selectedNote.body} />}
              <div className="map-tags">
                {selectedNote.tags?.map((t) => (
                  <button
                    key={t}
                    onClick={() => setFilter({ ...filter, tags: [t] })}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <h3>Evidence</h3>
              {anchorsOf(selectedNote).map((a, i) => (
                <section key={a.id || i}>
                  <button className="map-source" onClick={() => openSource(a)}>
                    {a.title || "Source"}
                    {a.media_id &&
                      ` · ${clock(a.start || 0)}–${clock(a.end ?? a.start ?? 0)}`}
                  </button>
                  {a.quote && <blockquote>{a.quote}</blockquote>}
                </section>
              ))}
              {!anchorsOf(selectedNote).length && (
                <p className="muted">A standalone note.</p>
              )}
              <h3>Connected notes</h3>
              {links
                .filter((l) => l.source === selected || l.target === selected)
                .map((l) => {
                  const other = research.notes.find(
                    (n) =>
                      n.id === (l.source === selected ? l.target : l.source),
                  );
                  return (
                    <div className="map-related" key={l.id}>
                      <button
                        onClick={() => {
                          setSelected(other?.id);
                          const id = items.find((i) =>
                            i.entries.some((e) => e.note.id === other?.id),
                          )?.id;
                          if (id)
                            void flow.current?.fitView({
                              nodes: [{ id }],
                              maxZoom: 1,
                              duration: 250,
                            });
                        }}
                      >
                        {other?.title}
                      </button>
                      <small>{l.label}</small>
                      {l.link && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setDraft({ next: l.link!, previous: l.link })
                          }
                        >
                          Edit connection
                        </Button>
                      )}
                    </div>
                  );
                })}
            </aside>
          )}
        </div>
      ) : (
        data && (
          <Empty
            icon={Network}
            title={
              research.notes.length
                ? "No notes match these filters"
                : "Give your ideas a place to meet"
            }
            text="Save passages as notes, then arrange and connect them here."
          />
        )
      )}
      {draft && (
        <LinkEditor
          key={JSON.stringify(draft)}
          draft={draft}
          notes={research.notes}
          onClose={() => setDraft(undefined)}
          onSaved={refresh}
        />
      )}
    </div>
  );
}
