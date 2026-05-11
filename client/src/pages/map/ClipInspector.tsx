import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TagChip } from "@/components/TagPicker";
import { Calendar, Clock, GitBranch, Play } from "lucide-react";
import { formatTimestamp, formatUploadDate } from "./helpers";
import type { GraphEdgeData, GraphNodeData } from "./types";

/**
 * Right-side details panel for the currently-selected note. Shows the
 * quote, tags, in-working-set relationships, and connected notes —
 * letting users jump between related notes without leaving the map.
 */
export function ClipInspector({
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
