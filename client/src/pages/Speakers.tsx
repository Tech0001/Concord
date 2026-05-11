import { useEffect, useState, useCallback, useMemo } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { SpeakerLabelDialog } from "@/components/SpeakerLabelDialog";
import { Mic, Play, UserPlus, Trash2, Pencil, X, Check, Users, RefreshCw, Search, VolumeX, GitMerge } from "lucide-react";

interface Speaker {
  id: string;
  name: string;
  display_color: string | null;
  notes: string | null;
  is_noise: number;
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
  const [mergingSpeaker, setMergingSpeaker] = useState<Speaker | null>(null);
  const [notesDraft, setNotesDraft] = useState<Record<string, string>>({});
  const [savingNotes, setSavingNotes] = useState<Record<string, boolean>>({});

  // Assignment workflow — uses shared SpeakerLabelDialog component
  const [assignTarget, setAssignTarget] = useState<UnidentifiedAssignment | null>(null);

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

  // First-mount: run a one-shot backfill if any speakers have appearance_count>0
  // but airtime=0 (the pre-Phase-1 stub-row case). The backfill is cheap
  // (just transcript file reads) and idempotent. After it completes, refetch
  // to get the populated values.
  const [didBackfill, setDidBackfill] = useState(false);
  useEffect(() => {
    if (didBackfill) return;
    if (loading) return;
    const needsBackfill = speakers.some(s => s.appearance_count > 0 && s.total_airtime_seconds === 0);
    if (!needsBackfill) return;
    setDidBackfill(true);
    apiRequest("POST", "/api/speakers/backfill-stats")
      .then(r => r.json())
      .then(({ backfilled }) => { if (backfilled > 0) fetchAll(); })
      .catch(() => { /* silent — non-critical */ });
  }, [loading, speakers, didBackfill, fetchAll]);

  // Same idea for orphan pruning: if any unidentified rows exist, run a
  // one-shot orphan sweep. Catches the "row in DB but no chip in
  // transcript" case caused by re-transcribes that produced different
  // local speakers than the prior run. Idempotent.
  const [didPrune, setDidPrune] = useState(false);
  useEffect(() => {
    if (didPrune) return;
    if (loading) return;
    if (unidentified.length === 0) return;
    setDidPrune(true);
    apiRequest("POST", "/api/speakers/prune-orphans")
      .then(r => r.json())
      .then(({ orphansRemoved }) => { if (orphansRemoved > 0) fetchAll(); })
      .catch(() => { /* silent — non-critical */ });
  }, [loading, unidentified, didPrune, fetchAll]);

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

  const findMatchesFor = async (s: Speaker) => {
    try {
      const r = await apiRequest("POST", `/api/speakers/${s.id}/find-matches`);
      const data = await r.json() as { matched: number };
      toast({
        title: data.matched > 0 ? `Matched ${s.name} in ${data.matched} more video${data.matched === 1 ? "" : "s"}` : `No new matches for ${s.name}`,
      });
      if (data.matched > 0) fetchAll();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Match scan failed", description: e.message });
    }
  };

  const rescanAll = async () => {
    try {
      const r = await apiRequest("POST", "/api/speakers/find-all-matches");
      const data = await r.json() as { matched: number };
      toast({
        title: data.matched > 0 ? `Auto-matched ${data.matched} unidentified voice${data.matched === 1 ? "" : "s"} across the archive` : "No new matches found",
      });
      if (data.matched > 0) fetchAll();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Rescan failed", description: e.message });
    }
  };

  const toggleNoise = async (s: Speaker) => {
    try {
      await apiRequest("PATCH", `/api/speakers/${s.id}`, { isNoise: s.is_noise === 1 ? false : true });
      setAppearances(prev => { const { [s.id]: _, ...rest } = prev; return rest; });
      fetchAll();
      toast({
        title: s.is_noise === 1 ? `${s.name} promoted to regular speaker` : `${s.name} marked as noise`,
        description: s.is_noise === 1
          ? "Now visible in Library badges and Search filter again."
          : "Hidden from Library badges and Search filter.",
      });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Toggle failed", description: e.message });
    }
  };

  const mergeSpeaker = async (source: Speaker, target: Speaker) => {
    if (source.id === target.id) {
      toast({ variant: "destructive", title: "Can't merge", description: "Pick a different target speaker." });
      return;
    }
    if (!confirm(`Merge "${source.name}" into "${target.name}"?\n\nAll videos labeled "${source.name}" will be relabeled "${target.name}". Their voice fingerprints will be combined. "${source.name}" will be deleted.`)) {
      return;
    }
    try {
      const r = await apiRequest("POST", `/api/speakers/${source.id}/merge`, { targetId: target.id });
      const data = await r.json() as { reassigned: number; centroidUpdated: boolean };
      toast({
        title: `Merged "${source.name}" → "${target.name}"`,
        description: `${data.reassigned} video assignment${data.reassigned === 1 ? "" : "s"} reassigned${data.centroidUpdated ? "; centroid combined" : ""}.`,
      });
      setMergingSpeaker(null);
      fetchAll();
    } catch (e: any) {
      toast({ variant: "destructive", title: "Merge failed", description: e.message });
    }
  };

  const saveSpeakerNotes = async (s: Speaker) => {
    const next = notesDraft[s.id] ?? "";
    if ((next || "") === (s.notes || "")) return;
    setSavingNotes((m) => ({ ...m, [s.id]: true }));
    try {
      await apiRequest("PATCH", `/api/speakers/${s.id}`, { notes: next.trim() || null });
      // Patch in-place to avoid a full refetch flicker
      setSpeakers((arr) => arr.map((x) => x.id === s.id ? { ...x, notes: next.trim() || null } : x));
      toast({ title: "Speaker notes saved" });
    } catch (e: any) {
      toast({ variant: "destructive", title: "Notes save failed", description: e.message });
    } finally {
      setSavingNotes((m) => ({ ...m, [s.id]: false }));
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

  const onAssignSaved = () => {
    setAppearances({});  // invalidate appearance cache for affected speakers
    fetchAll();
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
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base">Known voices</CardTitle>
            {speakers.length > 0 && unidentified.length > 0 && (
              <Button size="sm" variant="outline" onClick={rescanAll}>
                <Search className="h-3 w-3 mr-1.5"/>
                Rescan unidentified
              </Button>
            )}
          </div>
        </CardHeader>
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
                      <span className={`font-medium text-sm flex-1 truncate ${s.is_noise === 1 ? "italic text-muted-foreground" : ""}`}>
                        {s.name}
                        {s.is_noise === 1 && <span className="ml-1.5 text-[10px] uppercase tracking-wide opacity-60">noise</span>}
                      </span>
                      <Badge variant="secondary" className="text-[10px]">{fmtAirtime(s.total_airtime_seconds)}</Badge>
                      <Badge variant="outline" className="text-[10px]">{s.appearance_count} videos</Badge>
                      {s.has_embedding === 1 && (
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); findMatchesFor(s); }} title="Find more videos with this voice">
                          <RefreshCw className="h-3.5 w-3.5"/>
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={e => { e.stopPropagation(); toggleNoise(s); }}
                        title={s.is_noise === 1 ? "Promote back to regular speaker" : "Mark as noise / ignore"}
                      >
                        <VolumeX className={`h-3.5 w-3.5 ${s.is_noise === 1 ? "text-foreground" : "text-muted-foreground"}`}/>
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); beginEdit(s); }} title="Edit name and color">
                        <Pencil className="h-3.5 w-3.5"/>
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); setMergingSpeaker(s); }} title="Merge into another speaker">
                        <GitMerge className="h-3.5 w-3.5"/>
                      </Button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={e => { e.stopPropagation(); removeSpeaker(s); }} title="Delete speaker">
                        <Trash2 className="h-3.5 w-3.5 text-destructive"/>
                      </Button>
                    </>
                  )}
                </div>
                {isExpanded && (
                  <div className="border-t px-2 py-2 space-y-2 bg-muted/10">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] uppercase tracking-wide text-muted-foreground">Notes</label>
                        {savingNotes[s.id] && <span className="text-[10px] text-muted-foreground">saving…</span>}
                      </div>
                      <textarea
                        value={notesDraft[s.id] ?? s.notes ?? ""}
                        onChange={(e) => setNotesDraft((m) => ({ ...m, [s.id]: e.target.value }))}
                        onBlur={() => saveSpeakerNotes(s)}
                        rows={2}
                        placeholder="Notes about this speaker (saved on blur)…"
                        className="flex w-full resize-y rounded-md border border-input bg-background px-2 py-1 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>

                    <div>
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Appearances</div>
                      {(appearances[s.id] || []).length === 0 && (
                        <p className="text-xs text-muted-foreground p-1">No appearances yet.</p>
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
              <Button size="sm" variant="secondary" className="h-7 text-xs shrink-0" onClick={() => setAssignTarget(u)}>
                <UserPlus className="h-3 w-3 mr-1"/>Label
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {assignTarget && (
        <SpeakerLabelDialog
          open={true}
          onOpenChange={(o) => { if (!o) setAssignTarget(null); }}
          localSpeaker={assignTarget.local_speaker}
          contextLabel={assignTarget.video_title}
          videoId={assignTarget.video_id}
          channelId={assignTarget.channel_id}
          currentSpeakerId={null}
          onSaved={() => { onAssignSaved(); setAssignTarget(null); }}
        />
      )}

      <VideoDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
      />

      {mergingSpeaker && (
        <MergeSpeakerDialog
          source={mergingSpeaker}
          candidates={speakers.filter((s) => s.id !== mergingSpeaker.id && s.is_noise === 0)}
          onClose={() => setMergingSpeaker(null)}
          onConfirm={(target) => mergeSpeaker(mergingSpeaker, target)}
        />
      )}
    </div>
  );
}

function MergeSpeakerDialog({
  source, candidates, onClose, onConfirm,
}: {
  source: Speaker;
  candidates: Speaker[];
  onClose: () => void;
  onConfirm: (target: Speaker) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => c.name.toLowerCase().includes(q));
  }, [candidates, search]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm" onClick={onClose}>
      <Card className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <GitMerge className="h-4 w-4" /> Merge "{source.name}" into…
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Pick the speaker to merge "{source.name}" into. All videos labeled "{source.name}" will be relabeled, voice fingerprints combined, and "{source.name}" deleted.
          </p>
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search speakers…"
            className="h-8 text-sm"
          />
          <div className="max-h-64 overflow-y-auto rounded-md border">
            {filtered.length === 0 && (
              <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                {candidates.length === 0 ? "No other speakers to merge into." : "No speakers match."}
              </div>
            )}
            {filtered.map((c) => (
              <button
                key={c.id}
                onClick={() => onConfirm(c)}
                className="flex w-full items-center gap-2 border-b px-2.5 py-1.5 text-left text-sm last:border-0 hover:bg-secondary"
              >
                <span className="h-3 w-3 shrink-0 rounded-full border" style={{ background: c.display_color || "transparent" }} aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
              </button>
            ))}
          </div>
          <div className="flex justify-end pt-1">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
