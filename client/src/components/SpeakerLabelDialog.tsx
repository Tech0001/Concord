import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { UserPlus, Link2, X } from "lucide-react";

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#64748b", "#92400e",
];

export interface KnownSpeaker {
  id: string;
  name: string;
  display_color?: string | null;
}

export interface SpeakerLabelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The video-local label being assigned (e.g. "S0"). Shown for context. */
  localSpeaker: string;
  /** Human-readable context shown above the form (e.g. video title). */
  contextLabel?: string;
  /** Identifies the row in video_speaker_assignments to update. */
  videoId: string;
  channelId: string;
  /** If a global speaker is currently assigned, allow Unlink. */
  currentSpeakerId?: string | null;
  /** Callback after successful save (assign / unassign). */
  onSaved?: () => void;
}

export function SpeakerLabelDialog({
  open, onOpenChange, localSpeaker, contextLabel,
  videoId, channelId, currentSpeakerId, onSaved,
}: SpeakerLabelDialogProps) {
  const { toast } = useToast();
  const [knownSpeakers, setKnownSpeakers] = useState<KnownSpeaker[]>([]);
  const [mode, setMode] = useState<"new" | "merge">("new");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [mergeIntoId, setMergeIntoId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    apiRequest("GET", "/api/speakers")
      .then(r => r.json())
      .then(data => {
        const list: KnownSpeaker[] = data.speakers || [];
        setKnownSpeakers(list);
        // Default to "merge" mode when there's anything to merge into,
        // otherwise "new". Reset form on each open.
        setMode(list.length > 0 ? "new" : "new");
        setNewName("");
        setNewColor(PRESET_COLORS[list.length % PRESET_COLORS.length]);
        setMergeIntoId("");
      })
      .catch(() => setKnownSpeakers([]));
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    try {
      const body: any = { videoId, channelId, localSpeaker };
      if (mode === "new") {
        if (!newName.trim()) {
          toast({ variant: "destructive", title: "Name required" });
          setBusy(false);
          return;
        }
        body.newName = newName.trim();
        body.displayColor = newColor;
      } else {
        if (!mergeIntoId) {
          toast({ variant: "destructive", title: "Pick a speaker" });
          setBusy(false);
          return;
        }
        body.speakerId = mergeIntoId;
      }
      await apiRequest("POST", "/api/speakers/assign", body);
      toast({ title: "Speaker assigned" });
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Assign failed", description: e.message });
    } finally {
      setBusy(false);
    }
  };

  const unassign = async () => {
    setBusy(true);
    try {
      await apiRequest("POST", "/api/speakers/assign", {
        videoId, channelId, localSpeaker, speakerId: null,
      });
      toast({ title: "Speaker unassigned" });
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Unassign failed", description: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={() => !busy && onOpenChange(false)}
    >
      <Card className="w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Label voice</CardTitle>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onOpenChange(false)} aria-label="Close">
              <X className="h-4 w-4"/>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{localSpeaker}</span>
            {contextLabel && <span> in &quot;{contextLabel}&quot;</span>}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-1 text-xs">
            <Button size="sm" variant={mode === "new" ? "default" : "outline"} onClick={() => setMode("new")} className="flex-1">
              <UserPlus className="h-3 w-3 mr-1"/>New speaker
            </Button>
            <Button size="sm" variant={mode === "merge" ? "default" : "outline"} onClick={() => setMode("merge")} className="flex-1" disabled={knownSpeakers.length === 0}>
              <Link2 className="h-3 w-3 mr-1"/>Existing speaker
            </Button>
          </div>
          {mode === "new" ? (
            <>
              <Input
                placeholder="Speaker name (e.g. Joe Rogan)"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                autoFocus
                onKeyDown={e => { if (e.key === "Enter") submit(); }}
              />
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Color:</span>
                {PRESET_COLORS.map(c => (
                  <button
                    key={c}
                    type="button"
                    className={`h-6 w-6 rounded-full border-2 ${newColor === c ? "border-foreground" : "border-transparent"}`}
                    style={{ background: c }}
                    onClick={() => setNewColor(c)}
                    aria-label={`Color ${c}`}
                  />
                ))}
              </div>
            </>
          ) : (
            <Select value={mergeIntoId} onValueChange={setMergeIntoId}>
              <SelectTrigger><SelectValue placeholder="Pick a known speaker"/></SelectTrigger>
              <SelectContent>
                {knownSpeakers.map(s => (
                  <SelectItem key={s.id} value={s.id}>
                    <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle" style={{ background: s.display_color || "transparent" }}/>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex gap-2 justify-end pt-2">
            {currentSpeakerId && (
              <Button size="sm" variant="ghost" className="mr-auto text-destructive" onClick={unassign} disabled={busy}>
                Unlink
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={busy}>{busy ? "Saving…" : "Save"}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
