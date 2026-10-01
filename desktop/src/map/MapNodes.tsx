import { memo, type CSSProperties } from "react";
import {
  Handle,
  Position,
  NodeResizer,
  type Node,
  type NodeProps,
  type EdgeProps,
  BaseEdge,
  EdgeLabelRenderer,
} from "@xyflow/react";
import { BookOpen, FileText, Play, StickyNote } from "lucide-react";
import { clock } from "../lib/format.ts";
import { anchorsOf } from "../notes/model.ts";
import {
  handleKey,
  SIDES,
  type MapItem,
  type GraphLink,
  type Side,
} from "./model.ts";
import type { Note, NoteAnchor } from "../lib/types.ts";

export type ItemData = MapItem & {
  selectedNote?: string;
  select: (id: string) => void;
  open: (note: Note) => void;
  source: (a: NoteAnchor) => void;
  resized: (id: string, w: number, h: number, x: number, y: number) => void;
} & Record<string, unknown>;
export type ItemNode = Node<ItemData, "item">;
const sides: Record<Side, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom,
};
function Ports({ note, anchor = "" }: { note: Note; anchor?: string }) {
  return SIDES.map((side) => (
    <Handle
      key={side}
      type="source"
      position={sides[side]}
      id={handleKey(note.id!, anchor, side)}
      aria-label={`Connect ${note.title}${anchor ? " passage" : ""} · ${side}`}
    />
  ));
}
export const MapNode = memo(function MapNode({
  data,
  selected,
  id,
}: NodeProps<ItemNode>) {
  const note = data.entries[0].note;
  return (
    <article
      className={`map-card ${data.recording ? "map-recording" : ""} ${data.compact ? "map-compact" : ""} ${data.entries.some((e) => e.note.id === data.selectedNote) ? "has-selection" : ""}`}
      aria-label={data.title}
    >
      {!data.compact && (
        <NodeResizer
          isVisible={selected}
          minWidth={260}
          minHeight={150}
          onResizeEnd={(_, p) => data.resized(id, p.width, p.height, p.x, p.y)}
        />
      )}
      <header className="map-card-head">
        {data.recording ? <Play size={15} /> : <StickyNote size={15} />}
        <div>
          <strong>{data.title}</strong>
          <span>{data.subtitle}</span>
        </div>
      </header>
      {data.compact ? (
        <>
          <Ports note={note} />
          <button
            className="map-compact-open nodrag"
            aria-label={`Inspect ${note.title}`}
            onClick={(e) => {
              e.stopPropagation();
              data.select(note.id!);
            }}
          >
            Inspect note
          </button>
        </>
      ) : (
        <div className="map-card-body nowheel">
          {data.entries.map(({ note: n, anchor }) => (
            <section
              className={`map-entry ${data.selectedNote === n.id ? "is-selected" : ""}`}
              key={`${n.id}:${anchor?.id || ""}`}
            >
              <Ports note={n} anchor={anchor?.id} />
              <button
                className="map-note-title nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  data.select(n.id!);
                }}
              >
                {data.recording ? n.title : "Read note"}
              </button>
              {(anchor?.quote || (!data.recording && n.body)) && (
                <p>{anchor?.quote || n.body}</p>
              )}
              {anchor ? (
                <button
                  className="map-source nodrag"
                  onClick={(e) => {
                    e.stopPropagation();
                    data.source(anchor);
                  }}
                >
                  <Play size={12} />
                  {clock(anchor.start || 0)}–
                  {clock(anchor.end ?? anchor.start ?? 0)}
                </button>
              ) : (
                anchorsOf(n).map((a, i) => (
                  <div className="map-source-row" key={a.id || i}>
                    {a.id && <Ports note={n} anchor={a.id} />}
                    <button
                      className="map-source nodrag"
                      onClick={(e) => {
                        e.stopPropagation();
                        data.source(a);
                      }}
                    >
                      {a.media_id ? <Play size={12} /> : <FileText size={12} />}
                      <span>
                        {a.title || "Source"}
                        {a.media_id && ` · ${clock(a.start || 0)}`}
                      </span>
                    </button>
                  </div>
                ))
              )}
              {!!n.tags?.length && (
                <div className="map-tags">
                  {n.tags.map((t) => (
                    <span key={t}>{t}</span>
                  ))}
                </div>
              )}
              <button
                className="map-edit nodrag"
                onClick={(e) => {
                  e.stopPropagation();
                  data.open(n);
                }}
              >
                <BookOpen size={12} />
                Edit note
              </button>
            </section>
          ))}
        </div>
      )}
    </article>
  );
});
export function ArcEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  id,
  style,
  markerEnd,
  label,
  data,
  selected,
}: EdgeProps) {
  const height = Math.max(75, Math.abs(targetX - sourceX) * 0.35);
  const middle = (sourceX + targetX) / 2,
    top = Math.min(sourceY, targetY) - height;
  const path = `M ${sourceX},${sourceY} Q ${middle},${top} ${targetX},${targetY}`;
  const info = data?.graph as GraphLink | undefined;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ ...style, strokeWidth: selected ? 4 : style?.strokeWidth }}
        interactionWidth={20}
      />
      {selected && label && (
        <EdgeLabelRenderer>
          <span
            className="map-arc-label"
            style={
              {
                transform: `translate(-50%, -50%) translate(${middle}px,${(sourceY + targetY) / 4 + top / 2}px)`,
              } as CSSProperties
            }
          >
            {info?.label || String(label)}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
