import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { Mic, Play, UserPlus, Link2, Trash2, Pencil, X, Check, Users } from "lucide-react";

interface Speaker {
  id: string;
  name: string;
  display_color: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  total_airtime_seconds: number;
  appearance_count: number;
  has_embedding: number;
}

interface UnidentifiedAssignment {
  video_id: string;
  channel_id: string;
  local_speaker: string;
  speaker_id: null;
  airtime_seconds: number;
  sample_start: number | null;
  sample_end: number | null;
  video_title: string;
  video_url: string;
  video_path: string | null;
  channel_name: string | null;
  upload_date: string | null;
}

interface Appearance {
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  url: string;
  video_path: string | null;
  upload_date: string | null;
  local_speaker: string;
  airtime_seconds: number;
  sample_start: number | null;
  sample_end: number | null;
}

const PRESET_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#64748b", "#92400e",
];

function fmtAirtime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export default function Speakers() {
  const { toast } = useToast();
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [unidentified, setUnidentified] = useState<UnidentifiedAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSpeaker, setExpandedSpeaker] = useState<string | null>(null);
  const [appearances, setAppearances] = useState<Record<string, Appearance[]>>({});
  const [editingSpeaker, setEditingSpeaker] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState<string | null>(null);

  // Assignment workflow state
  const [assignTarget, setAssignTarget] = useState<UnidentifiedAssignment | null>(null);
  const [assignMode, setAssignMode] = useState<"new" | "merge">("new");
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>(PRESET_COLORS[0]);
  const [mergeIntoId, setMergeIntoId] = useState<string>("");

  // VideoDrawer state for sample playback
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, u] = await Promise.all([
        apiRequest("GET", "/api/speakers").then(r => r.json()),
        apiRequest("GET", "/api/speakers/unidentified").then(r => r.json()),
      ]);
      setSpeakers(s.speakers || []);
      setUnidentified(u.assignments || []);
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to load speakers", description: e.message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const fetchAppearances = useCallback(async (speakerId: string) => {
    if (appearances[speakerId]) return;
    try {
      const r = await apiRequest("GET", `/api/speakers/${speakerId}`);
      const data = await r.json();
      setAppearances(prev => ({ ...prev, [speakerId]: data.appearances || [] }));
    } catch (e: any) {
      toast({ variant: "destructive", title: "Failed to load appearances", description: e.message });
    }
  }, [appearances, toast]);

  const playSample = (entry: {
    video_id: string; channel_id: string; channel_name: string | null;
    title: string; url?: string; video_path: string | null;
    upload_date: string | null; sample_start: number | null;
  }) => {
    setDrawerVideo({
      video_id: entry.video_id,
      channel_id: entry.channel_id,
      channel_name: entry.channel_name,
      title: entry.title,
      upload_date: entry.upload_date,
      status: "complete",
      is_live: 0,
      video_path: entry.video_path,
      md_path: null,
      word_count: 0,
    });
    setDrawerSeconds(entry.sample_start ?? 0);
    setDrawerOpen(true);
  };

  const beginEdit = (s: Speaker) => {
    setEditingSpeaker(s.id);
    setEditName(s.name);
    setEditColor(s.display_color);
  };
  const cancelEdit = () => { setEditingSpeaker(null); setEditName(""); setEditColor(null); };
  const saveEdit = async (id: string) => {
    try {
      await apiRequest("PATCH", `/api/speakers/${id}`, { name: editName, displayColor: editColor });
      cancelEdit();
      fetchAll();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Update failed", description: e.message });
    }
  };

  const removeSpeaker = async (s: Speaker) => {
    if (!confirm(`Delete speaker "${s.name}"?\nAny videos labeled with this speaker will become unidentified again.`)) return;
    try {
      await apiRequest("DELETE", `/api/speakers/${s.id}`);
      setAppearances(prev => { const { [s.id]: _, ...rest } = prev; return rest; });
      fetchAll();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Delete failed", description: e.message });
    }
  };

  const openAssign = (assignment: UnidentifiedAssignment) => {
    setAssignTarget(assignment);
    setAssignMode(speakers.length > 0 ? "new" : "new");
    setNewName("");
    setNewColor(PRESET_COLORS[speakers.length % PRESET_COLORS.length]);
    setMergeIntoId("");
  };

  const submitAssign = async () => {
    if (!assignTarget) return;
    try {
      const body: any = {
        videoId: assignTarget.video_id,
        channelId: assignTarget.channel_id,
        localSpeaker: assignTarget.local_speaker,
      };
      if (assignMode === "new") {
        if (!newName.trim()) {
          toast({ variant: "destructive", title: "Name required" });
          return;
        }
        body.newName = newName.trim();
        body.displayColor = newColor;
      } else {
        if (!mergeIntoId) {
          toast({ variant: "destructive", title: "Pick a speaker" });
          return;
        }
        body.speakerId = mergeIntoId;
      }
      await apiRequest("POST", "/api/speakers/assign", body);
      setAssignTarget(null);
      // Invalidate appearance cache for any affected speakers
      setAppearances({});
      fetchAll();
      toast({ title: "Speaker assigned" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Assign failed", description: e.message });
    }
  };

  const totalAirtime = useMemo(
    () => speakers.reduce((acc, s) => acc + s.total_airtime_seconds, 0),
    [speakers],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2"><Users className="h-5 w-5"/>Speakers</CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{speakers.length} known</Badge>
              <Badge variant="outline">{unidentified.length} unidentified</Badge>
              {totalAirtime > 0 && <Badge variant="outline">{fmtAirtime(totalAirtime)} labeled</Badge>}
            </div>
          </div>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">
          Voices are auto-detected from diarized transcripts. The system tries to match each new
          video's speakers against known voices automatically (cosine threshold 0.55) — anything it
          can't match cleanly shows up below for you to label or merge.
        </CardContent>
      </Card>

      {/* Known speakers */}
      <Card>
        <CardHeader><CardTitle className="text-base">Known voices</CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          {loading && speakers.length === 0 && (
            <p className="text-xs text-muted-foreground">Loading…</p>
          )}
          {!loading && speakers.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No speakers yet. Label some unidentified voices below to start your library.
            </p>
          )}
          {speakers.map(s => {
            const isExpanded = expandedSpeaker === s.id;
            const isEditing = editingSpeaker === s.id;
            return (
              <div key={s.id} className="rounded border bg-card">
                <div
                  className="flex items-center gap-2 p-2 hover:bg-muted/30 cursor-pointer"
                  onClick={() => {
                    if (isEditing) return;
                    setExpandedSpeaker(isExpanded ? null : s.id);
                    if (!isExpanded) fetchAppearances(s.id);
                  }}
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full border"
                    style={{ background: (isEditing ? editColor : s.display_color) || "transparent" }}
                    aria-hidden
                  />
                  {isEditing ? (
                    <>
                      <Input
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        className="h-7 text-sm"
                        autoFocus
                        onClick={e => e.stopPropagation()}
                      />
                      <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
                        {PRESET_COLORS.map(c => (
                          <button
                            key={c}
                            type="button"
                            className={`h-5 w-5 rounded-full border-2 ${editColor === c ? "border-foreground" : "border-transparent"}`}
                            style={{ background: c }}
                            onClick={() => setEditColor(c)}
                            aria-label={`Color ${c}`}
                          />
                        ))}
                      </div>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); saveEdit(s.id); }}>
                        <Check className="h-3.5 w-3.5"/>
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); cancelEdit(); }}>
                        <X className="h-3.5 w-3.5"/>
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="font-medium text-sm flex-1 truncate">{s.name}</span>
                      <Badge variant="secondary" className="text-[10px]">{fmtAirtime(s.total_airtime_seconds)}</Badge>
                      <Badge variant="outline" className="text-[10px]">{s.appearance_count} videos</Badge>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); beginEdit(s); }}>
                        <Pencil className="h-3.5 w-3.5"/>
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); removeSpeaker(s); }}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive"/>
                      </Button>
                    </>
                  )}
                </div>
                {isExpanded && (
                  <div className="border-t px-2 py-2 space-y-1 bg-muted/10">
                    {(appearances[s.id] || []).length === 0 && (
                      <p className="text-xs text-muted-foreground p-2">No appearances yet.</p>
                    )}
                    {(appearances[s.id] || []).map(ap => (
                      <div key={`${ap.video_id}|${ap.local_speaker}`} className="flex items-center gap-2 text-xs p-1">
                        <span className="font-mono text-[10px] rounded bg-secondary px-1 py-0.5">{ap.local_speaker}</span>
                        <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" disabled={ap.sample_start == null} onClick={() => playSample(ap)}>
                          <Play className="h-3 w-3"/>
                        </Button>
                        <span className="flex-1 truncate" title={ap.title}>{ap.title}</span>
                        <span className="text-muted-foreground shrink-0">{ap.channel_name}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">{fmtAirtime(ap.airtime_seconds)}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Unidentified voices */}
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Mic className="h-4 w-4"/>Unidentified voices</CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          {!loading && unidentified.length === 0 && (
            <p className="text-xs text-muted-foreground">All voices in your archive are labeled. Nice.</p>
          )}
          {unidentified.map(u => (
            <div key={`${u.video_id}|${u.channel_id}|${u.local_speaker}`} className="flex items-center gap-2 rounded border bg-card p-2 text-xs">
              <span className="font-mono text-[10px] rounded bg-secondary px-1 py-0.5">{u.local_speaker}</span>
              <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" disabled={u.sample_start == null} onClick={() => playSample({
                video_id: u.video_id, channel_id: u.channel_id,
                channel_name: u.channel_name, title: u.video_title,
                video_path: u.video_path, upload_date: u.upload_date,
                sample_start: u.sample_start,
              })}>
                <Play className="h-3 w-3"/>
              </Button>
              <div className="flex-1 truncate">
                <div className="truncate" title={u.video_title}>{u.video_title}</div>
                <div className="text-[10px] text-muted-foreground truncate">{u.channel_name}</div>
              </div>
              <Badge variant="outline" className="text-[10px] shrink-0">{fmtAirtime(u.airtime_seconds)}</Badge>
              <Button size="sm" variant="secondary" className="h-7 text-xs shrink-0" onClick={() => openAssign(u)}>
                <UserPlus className="h-3 w-3 mr-1"/>Label
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Inline assign modal */}
      {assignTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" onClick={() => setAssignTarget(null)}>
          <Card className="w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <CardHeader>
              <CardTitle className="text-base">Label voice</CardTitle>
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">{assignTarget.local_speaker}</span> in &quot;{assignTarget.video_title}&quot;
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-1 text-xs">
                <Button size="sm" variant={assignMode === "new" ? "default" : "outline"} onClick={() => setAssignMode("new")} className="flex-1">
                  <UserPlus className="h-3 w-3 mr-1"/>New speaker
                </Button>
                <Button size="sm" variant={assignMode === "merge" ? "default" : "outline"} onClick={() => setAssignMode("merge")} className="flex-1" disabled={speakers.length === 0}>
                  <Link2 className="h-3 w-3 mr-1"/>Existing speaker
                </Button>
              </div>
              {assignMode === "new" ? (
                <>
                  <Input placeholder="Speaker name (e.g. Joe Rogan)" value={newName} onChange={e => setNewName(e.target.value)} autoFocus onKeyDown={e => { if (e.key === "Enter") submitAssign(); }}/>
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
                    {speakers.map(s => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="inline-block h-2 w-2 rounded-full mr-2 align-middle" style={{ background: s.display_color || "transparent" }}/>
                        {s.name} <span className="text-muted-foreground">({fmtAirtime(s.total_airtime_seconds)})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="flex gap-2 justify-end pt-2">
                <Button size="sm" variant="ghost" onClick={() => setAssignTarget(null)}>Cancel</Button>
                <Button size="sm" onClick={submitAssign}>Save</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <VideoDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
      />
    </div>
  );
}
