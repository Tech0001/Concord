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

export interface OtherLocalSpeakerOption {
  localSpeaker: string;
  airtimeSeconds: number;
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
  /** Other unidentified local speakers in the same video. When provided,
   *  the dialog shows checkboxes so the user can label several at once as
   *  the same person — handy when over-segmentation split one speaker
   *  into multiple S* chips. */
  otherUnidentified?: OtherLocalSpeakerOption[];
  /** Callback after successful save (assign / unassign). */
  onSaved?: () => void;
}

function fmtAirtime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function SpeakerLabelDialog({
  open, onOpenChange, localSpeaker, contextLabel,
  videoId, channelId, currentSpeakerId, otherUnidentified, onSaved,
}: SpeakerLabelDialogProps) {
  const { toast } = useToast();
  const [knownSpeakers, setKnownSpeakers] = useState<KnownSpeaker[]>([]);
  const [mode, setMode] = useState<"new" | "merge">("new");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(PRESET_COLORS[0]);
  const [mergeIntoId, setMergeIntoId] = useState("");
  const [busy, setBusy] = useState(false);
  /** Set of "other" local speakers the user picked to label together. */
  const [alsoLabel, setAlsoLabel] = useState<Set<string>>(new Set());

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
        setAlsoLabel(new Set());
      })
      .catch(() => setKnownSpeakers([]));
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    try {
      const body: any = { videoId, channelId, localSpeaker };
      if (alsoLabel.size > 0) {
        body.additionalLocalSpeakers = Array.from(alsoLabel);
      }
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
      const r = await apiRequest("POST", "/api/speakers/assign", body);
      const data = await r.json() as { autoMatched?: number; additionalAssigned?: number };
      const extras: string[] = [];
      if (data.additionalAssigned) extras.push(`+${data.additionalAssigned} other label${data.additionalAssigned === 1 ? "" : "s"} in this video`);
      if (data.autoMatched) extras.push(`auto-matched in ${data.autoMatched} other video${data.autoMatched === 1 ? "" : "s"}`);
      toast({
        title: "Speaker assigned",
        description: extras.length > 0 ? extras.join(" · ") : undefined,
      });
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

          {otherUnidentified && otherUnidentified.length > 0 && (
            <div className="rounded-md border border-dashed p-2 space-y-1 bg-muted/20">
              <div className="text-xs font-medium text-muted-foreground">
                Also label these as the same person?
                <span className="ml-1 text-muted-foreground/70">
                  ({otherUnidentified.length} other unidentified in this video)
                </span>
              </div>
              <div className="max-h-32 overflow-y-auto space-y-0.5 pr-1">
                {otherUnidentified.map(o => {
                  const checked = alsoLabel.has(o.localSpeaker);
                  return (
                    <label key={o.localSpeaker} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-muted/30 rounded px-1 py-0.5">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(alsoLabel);
                          if (checked) next.delete(o.localSpeaker); else next.add(o.localSpeaker);
                          setAlsoLabel(next);
                        }}
                      />
                      <span className="font-mono">{o.localSpeaker}</span>
                      <span className="text-muted-foreground ml-auto">{fmtAirtime(o.airtimeSeconds)}</span>
                    </label>
                  );
                })}
              </div>
              {alsoLabel.size > 0 && (
                <div className="text-[10px] text-muted-foreground pt-1">
                  Will label {alsoLabel.size + 1} local speakers in this video as one person.
                </div>
              )}
            </div>
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
