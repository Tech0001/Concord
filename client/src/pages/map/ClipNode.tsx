import { Handle, Position } from "@xyflow/react";
import { TagChip } from "@/components/TagPicker";
import { cn } from "@/lib/utils";
import { channelColor, formatTimestamp } from "./helpers";
import { DEFAULT_CLIP_WIDTH, type GraphNodeData } from "./types";

/**
 * Card for a single note rendered as a React Flow node — used in "Cards"
 * mode and for standalone notes in "Videos" mode. Branches on anchor
 * count to surface multi-anchor reach inline ("3 anchors across 2 videos")
 * vs. the simpler legacy single-anchor display.
 */
export function ClipNode({ data, selected }: { data: GraphNodeData; selected?: boolean }) {
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
      {/* One handle per side, type="source"; ReactFlow runs in loose
       *  connectionMode at the canvas level so any handle can be dragged to
       *  any other handle (right→right, top→bottom, etc.). Multiple links
       *  can share the same handle — the edges fan out via bezier curves. */}
      <Handle id="left"   type="source" position={Position.Left}   className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
      <Handle id="right"  type="source" position={Position.Right}  className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
      <Handle id="top"    type="source" position={Position.Top}    className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="!h-3 !w-3 !border-2 !border-background !bg-primary" />
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
