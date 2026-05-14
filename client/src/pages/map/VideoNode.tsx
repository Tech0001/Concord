import { Handle, NodeResizer, Position } from "@xyflow/react";
import { TagChip } from "@/components/TagPicker";
import { cn } from "@/lib/utils";
import { channelColor, formatTimestamp, formatUploadDate } from "./helpers";
import type { VideoNodeData } from "./types";

/**
 * The "video container" node — used in "Videos" mode to group every note
 * anchored to a single video. Multi-anchor notes appear in multiple
 * VideoNodes (once per video they touch), each with their per-anchor
 * timestamp. Handle ids use `${clipId}:${anchorOrdinal}` so React Flow
 * can address each appearance distinctly when drawing edges.
 */
export function VideoNode({ data, selected }: { data: VideoNodeData; selected?: boolean }) {
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
            {/* Four handles per row (loose connectionMode at the canvas level
             *  lets any handle connect to any other). Handle ids encode the
             *  side so the edge renderer can address them precisely. Top /
             *  bottom are small to avoid eating row height — they sit on
             *  the row's top/bottom border. */}
            {(() => {
              const ord = typeof clip.anchorOrdinal === "number" ? clip.anchorOrdinal : 1;
              return (
                <>
                  <Handle id={`${clip.id}:${ord}:left`}   type="source" position={Position.Left}   className="!left-2 !h-5 !w-5 !border-2 !border-background !bg-primary" />
                  <Handle id={`${clip.id}:${ord}:right`}  type="source" position={Position.Right}  className="!right-2 !h-5 !w-5 !border-2 !border-background !bg-primary" />
                  <Handle id={`${clip.id}:${ord}:top`}    type="source" position={Position.Top}    className="!h-2 !w-2 !border-2 !border-background !bg-primary" />
                  <Handle id={`${clip.id}:${ord}:bottom`} type="source" position={Position.Bottom} className="!h-2 !w-2 !border-2 !border-background !bg-primary" />
                </>
              );
            })()}
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
        Drag from any handle (top / right / bottom / left) to any other.
      </div>
    </div>
  );
}
