import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TagChip, TagPicker } from "@/components/TagPicker";
import { VideoDrawer, type VideoDrawerEntry } from "@/components/VideoDrawer";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCategory } from "@/hooks/use-category";
import {
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  FileText,
  Link as LinkIcon,
  NotebookText,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";

interface Channel {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

interface ClipAnchor {
  ordinal: number;
  video_id: string | null;
  channel_id: string | null;
  channel_name: string | null;
  video_title: string | null;
  upload_date: string | null;
  start_seconds: number | null;
  end_seconds: number | null;
  excerpt: string | null;
  video_path: string | null;
  md_path: string | null;
  status: string | null;
  is_live: number | null;
  duration: number | null;
  word_count: number | null;
  /** Doc-source fields — set when this anchor points at a markdown
   *  file instead of a video. Mutually exclusive with the video
   *  fields above. */
  document_id: string | null;
  doc_rel_path: string | null;
  doc_title: string | null;
  doc_start_char: number | null;
  doc_end_char: number | null;
}

interface ClipEntry {
  id: string;
  video_id: string;
  channel_id: string;
  title: string;
  channel_name: string | null;
  upload_date: string | null;
  start_seconds: number;
  end_seconds: number;
  quote: string;
  note: string | null;
  created_at: string;
  video_path: string | null;
  md_path: string | null;
  word_count: number;
  is_live: number;
  duration: number | null;
  status: string;
  tags: string[];
  anchors: ClipAnchor[];
}

interface TagCount {
  tag: string;
  count: number;
}

const LINK_KINDS = [
  { value: "same_claim",     label: "Same claim" },
  { value: "contradicts",    label: "Contradicts" },
  { value: "same_topic", label: "Same topic" },
  { value: "follow_up",      label: "Follow-up" },
  { value: "context",        label: "Context" },
] as const;

type ClipLinkKind = (typeof LINK_KINDS)[number]["value"];

const SYMMETRIC_KINDS = new Set<ClipLinkKind>(["same_claim", "contradicts", "same_topic"]);

function kindLabel(kind: ClipLinkKind): string {
  return LINK_KINDS.find(k => k.value === kind)?.label || kind;
}

interface ClipLink {
  from_clip_id: string;
  to_clip_id: string;
  kind: ClipLinkKind;
  note: string | null;
  created_at: string;
  direction: "outgoing" | "incoming";
  other: ClipEntry;
}

function formatUploadDate(uploadDate: string | null): string {
  if (!uploadDate) return "No date";
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`;
  }
  return uploadDate;
}

function formatTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

const POPULAR_LIMIT = 12;

export default function Clips() {
  const [clips, setClips] = useState<ClipEntry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [allTags, setAllTags] = useState<TagCount[]>([]);
  const [query, setQuery] = useState("");
  const [channelId, setChannelId] = useState("all");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [editingTagsForClipId, setEditingTagsForClipId] = useState<string | null>(null);
  const [showAdmin, setShowAdmin] = useState(false);
  const [renameFrom, setRenameFrom] = useState("");
  const [renameTo, setRenameTo] = useState("");
  const [renameDescendants, setRenameDescendants] = useState(false);
  const [loading, setLoading] = useState(false);
  const [drawerVideo, setDrawerVideo] = useState<VideoDrawerEntry | null>(null);
  const [drawerSeconds, setDrawerSeconds] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [linksByClipId, setLinksByClipId] = useState<Record<string, ClipLink[]>>({});
  const [linkPickerSourceId, setLinkPickerSourceId] = useState<string | null>(null);
  const [linkPickerQuery, setLinkPickerQuery] = useState("");
  const [linkPickerResults, setLinkPickerResults] = useState<ClipEntry[]>([]);
  const [linkPickerKind, setLinkPickerKind] = useState<ClipLinkKind>("same_claim");
  const [linkPickerNote, setLinkPickerNote] = useState("");
  const [linkPickerSearching, setLinkPickerSearching] = useState(false);
  const [linkPickerSaving, setLinkPickerSaving] = useState(false);
  const { toast } = useToast();
  const { serverCategory } = useCategory();

  const linkPickerSource = useMemo(
    () => clips.find(c => c.id === linkPickerSourceId) || null,
    [clips, linkPickerSourceId],
  );

  const clipCountByVideo = useMemo(() => {
    return new Set(clips.map(clip => `${clip.channel_id}:${clip.video_id}`)).size;
  }, [clips]);

  const loadTags = async () => {
    try {
      const response = await apiRequest("GET", `/api/clips/tags?t=${Date.now()}`);
      const data = await response.json() as { tags?: TagCount[] };
      setAllTags(data.tags || []);
    } catch {
      setAllTags([]);
    }
  };

  const loadLinksFor = async (ids: string[]) => {
    if (!ids.length) {
      setLinksByClipId({});
      return;
    }
    const results = await Promise.all(
      ids.map(async id => {
        try {
          const response = await apiRequest("GET", `/api/clips/${id}/links?t=${Date.now()}`);
          const data = await response.json() as { links?: ClipLink[] };
          return [id, data.links || []] as const;
        } catch {
          return [id, [] as ClipLink[]] as const;
        }
      }),
    );
    setLinksByClipId(Object.fromEntries(results));
  };

  const loadData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        q: query.trim(),
        channelId,
        limit: "250",
        t: String(Date.now()),
      });
      if (tagFilter.length) params.set("tags", tagFilter.join(","));
      if (serverCategory) params.set("category", serverCategory);

      const [clipsRes, configRes] = await Promise.all([
        apiRequest("GET", `/api/clips?${params.toString()}`),
        apiRequest("GET", `/api/pipeline/config?t=${Date.now()}`),
      ]);
      const clipsData = await clipsRes.json() as { rows?: ClipEntry[] };
      const configData = await configRes.json() as { channels?: Channel[] };
      const rows = clipsData.rows || [];
      setClips(rows);
      setChannels(configData.channels || []);
      await Promise.all([loadTags(), loadLinksFor(rows.map(r => r.id))]);
    } catch (error: any) {
      toast({ variant: "destructive", title: "Notes load failed", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [channelId, tagFilter, serverCategory]);

  const deleteClip = async (clip: ClipEntry) => {
    try {
      await apiRequest("DELETE", `/api/clips/${clip.id}`);
      setClips(current => current.filter(item => item.id !== clip.id));
      toast({ title: "Clip deleted" });
      await loadTags();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Delete failed", description: error.message });
    }
  };

  const updateClipTags = async (clip: ClipEntry, tags: string[]) => {
    try {
      const response = await apiRequest("PATCH", `/api/clips/${clip.id}/tags`, { tags });
      const data = await response.json() as { tags: string[] };
      setClips(current => current.map(item => item.id === clip.id ? { ...item, tags: data.tags } : item));
      await loadTags();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Update tags failed", description: error.message });
    }
  };

  const toggleTagFilter = (tag: string) => {
    setTagFilter(current => current.includes(tag) ? current.filter(t => t !== tag) : [...current, tag]);
  };

  const renameTag = async () => {
    if (!renameFrom.trim() || !renameTo.trim()) return;
    try {
      const response = await apiRequest("POST", "/api/clips/tags/rename", {
        from: renameFrom,
        to: renameTo,
        includeDescendants: renameDescendants,
      });
      const data = await response.json() as { renamed: number; merged: number };
      toast({
        title: "Tag renamed",
        description: `${data.renamed} renamed, ${data.merged} merged into existing.`,
      });
      setRenameFrom("");
      setRenameTo("");
      setRenameDescendants(false);
      await loadData();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Rename failed", description: error.message });
    }
  };

  const deleteTagGlobal = async (tag: string, includeDescendants = false) => {
    if (!window.confirm(`Remove tag "${tag}"${includeDescendants ? " (with descendants)" : ""} from all notes?`)) return;
    try {
      const response = await apiRequest(
        "DELETE",
        `/api/clips/tags/${encodeURIComponent(tag)}?includeDescendants=${includeDescendants}`,
      );
      const data = await response.json() as { removed: number };
      toast({ title: "Tag removed", description: `${data.removed} removed.` });
      setTagFilter(current => current.filter(t => t !== tag));
      await loadData();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Remove tag failed", description: error.message });
    }
  };

  const openLinkPicker = (clip: ClipEntry) => {
    setLinkPickerSourceId(clip.id);
    setLinkPickerQuery("");
    setLinkPickerResults([]);
    setLinkPickerKind("same_claim");
    setLinkPickerNote("");
  };

  const closeLinkPicker = () => {
    setLinkPickerSourceId(null);
  };

  const searchClipsForPicker = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) {
      setLinkPickerResults([]);
      return;
    }
    setLinkPickerSearching(true);
    try {
      const params = new URLSearchParams({ q: trimmed, limit: "20", t: String(Date.now()) });
      const response = await apiRequest("GET", `/api/clips?${params.toString()}`);
      const data = await response.json() as { rows?: ClipEntry[] };
      setLinkPickerResults((data.rows || []).filter(c => c.id !== linkPickerSourceId));
    } catch {
      setLinkPickerResults([]);
    } finally {
      setLinkPickerSearching(false);
    }
  };

  const saveLink = async (target: ClipEntry) => {
    if (!linkPickerSource) return;
    setLinkPickerSaving(true);
    try {
      await apiRequest("POST", `/api/clips/${linkPickerSource.id}/links`, {
        toId: target.id,
        kind: linkPickerKind,
        note: linkPickerNote || null,
      });
      toast({ title: "Linked", description: `${kindLabel(linkPickerKind)} → ${target.title}` });
      const idsToRefresh = [linkPickerSource.id, target.id].filter(id => clips.some(c => c.id === id));
      await loadLinksFor(clips.map(c => c.id).filter(id => idsToRefresh.includes(id) || linksByClipId[id] !== undefined));
      closeLinkPicker();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Link failed", description: error.message });
    } finally {
      setLinkPickerSaving(false);
    }
  };

  const removeLink = async (link: ClipLink, fromClipId: string) => {
    try {
      await apiRequest("DELETE", `/api/clips/${fromClipId}/links/${link.other.id}/${link.kind}`);
      await loadLinksFor(clips.map(c => c.id));
    } catch (error: any) {
      toast({ variant: "destructive", title: "Remove link failed", description: error.message });
    }
  };

  const openClip = (clip: ClipEntry) => {
    setDrawerVideo({
      video_id: clip.video_id,
      channel_id: clip.channel_id,
      channel_name: clip.channel_name || clip.channel_id,
      title: clip.title,
      upload_date: clip.upload_date,
      duration: clip.duration,
      status: clip.status,
      is_live: clip.is_live,
      video_path: clip.video_path,
      md_path: clip.md_path,
      word_count: clip.word_count,
    });
    setDrawerSeconds(clip.start_seconds);
    setDrawerOpen(true);
  };

  const openAnchor = (anchor: ClipAnchor) => {
    // Doc anchors don't open in the VideoDrawer — route to the Docs
    // viewer for the source file instead.
    if (anchor.document_id && anchor.doc_rel_path) {
      const qs = new URLSearchParams({ path: anchor.doc_rel_path });
      if (anchor.excerpt) qs.set("excerpt", anchor.excerpt);
      window.location.href = `/docs?${qs.toString()}`;
      return;
    }
    if (!anchor.video_id || !anchor.channel_id) return;
    setDrawerVideo({
      video_id: anchor.video_id,
      channel_id: anchor.channel_id,
      channel_name: anchor.channel_name || anchor.channel_id,
      title: anchor.video_title || "Source video",
      upload_date: anchor.upload_date,
      duration: anchor.duration,
      status: anchor.status ?? undefined,
      is_live: anchor.is_live ?? undefined,
      video_path: anchor.video_path,
      md_path: anchor.md_path,
      word_count: anchor.word_count ?? 0,
    });
    setDrawerSeconds(anchor.start_seconds ?? 0);
    setDrawerOpen(true);
  };

  const removeAnchor = async (clip: ClipEntry, anchor: ClipAnchor) => {
    const willBeStandalone = clip.anchors.length === 1;
    const prompt = willBeStandalone
      ? `Remove the last anchor on "${clip.title}"? The note will become standalone (no video link).`
      : `Remove this anchor from "${clip.title}"?`;
    if (!confirm(prompt)) return;
    try {
      await apiRequest("DELETE", `/api/clips/${clip.id}/anchors/${anchor.ordinal}`);
      await loadData();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Remove anchor failed", description: error.message });
    }
  };

  const [addAnchorFor, setAddAnchorFor] = useState<ClipEntry | null>(null);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<ClipEntry | null>(null);

  // 2-pane state — which note is currently selected in the sidebar.
  // Auto-select first note when list loads; null = empty detail pane.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  type SortMode = "recent" | "created" | "title" | "anchors";
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  type AnchorFilter = "all" | "standalone" | "anchored";
  const [anchorFilter, setAnchorFilter] = useState<AnchorFilter>("all");

  // Per-detail inline-edit drafts so the user types into the pane and we
  // save on blur. Keyed by note id so switching notes doesn't trample.
  const [titleDraft, setTitleDraft] = useState<Record<string, string>>({});
  const [bodyDraft, setBodyDraft] = useState<Record<string, string>>({});

  const visibleClips = useMemo(() => {
    let list = clips.slice();
    if (anchorFilter === "standalone") list = list.filter((c) => c.anchors.length === 0);
    else if (anchorFilter === "anchored") list = list.filter((c) => c.anchors.length > 0);
    switch (sortMode) {
      case "recent": list.sort((a, b) => b.created_at.localeCompare(a.created_at)); break;
      case "created": list.sort((a, b) => a.created_at.localeCompare(b.created_at)); break;
      case "title": list.sort((a, b) => a.title.localeCompare(b.title)); break;
      case "anchors": list.sort((a, b) => b.anchors.length - a.anchors.length || b.created_at.localeCompare(a.created_at)); break;
    }
    return list;
  }, [clips, anchorFilter, sortMode]);

  // Auto-select the first visible note when the list changes and the
  // current selection is no longer visible (or none is selected yet).
  useEffect(() => {
    if (visibleClips.length === 0) { setSelectedId(null); return; }
    if (!selectedId || !visibleClips.find((c) => c.id === selectedId)) {
      setSelectedId(visibleClips[0].id);
    }
  }, [visibleClips, selectedId]);

  const selectedClip = useMemo(
    () => clips.find((c) => c.id === selectedId) ?? null,
    [clips, selectedId],
  );

  const saveTitleInline = async (clip: ClipEntry) => {
    const next = (titleDraft[clip.id] ?? clip.title).trim();
    if (!next || next === clip.title) return;
    try {
      await apiRequest("PATCH", `/api/clips/${clip.id}`, { title: next });
      setClips((arr) => arr.map((c) => c.id === clip.id ? { ...c, title: next } : c));
    } catch (e: any) {
      toast({ variant: "destructive", title: "Save failed", description: e.message });
    }
  };

  const saveBodyInline = async (clip: ClipEntry) => {
    const next = (bodyDraft[clip.id] ?? clip.note ?? "").trim();
    if ((next || null) === (clip.note || null)) return;
    try {
      await apiRequest("PATCH", `/api/clips/${clip.id}`, { note: next || null });
      setClips((arr) => arr.map((c) => c.id === clip.id ? { ...c, note: next || null } : c));
    } catch (e: any) {
      toast({ variant: "destructive", title: "Save failed", description: e.message });
    }
  };

  const popularTags = allTags.slice(0, POPULAR_LIMIT);

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="flex items-center gap-2">
              <NotebookText className="h-4 w-4" />
              Notes
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") loadData(); }}
                  placeholder="Search notes"
                  className="h-9 pl-8 w-full sm:w-80"
                />
              </div>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels</SelectItem>
                  {channels.map(channel => <SelectItem key={channel.id} value={channel.id}>{channel.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={() => setNewNoteOpen(true)} className="h-9">
                <Plus className="h-4 w-4 mr-1" />
                New note
              </Button>
              <Button size="sm" variant="outline" onClick={loadData} disabled={loading} className="h-9">
                <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-muted-foreground">Filter by tag:</span>
            <TagPicker
              value={tagFilter}
              onChange={setTagFilter}
              options={allTags}
              size="sm"
              placeholder="Pick tags..."
              onOpen={loadTags}
            />
            {tagFilter.length > 0 && (
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setTagFilter([])}>
                Clear
              </Button>
            )}
          </div>

          {popularTags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">Popular:</span>
              {popularTags.map(({ tag, count }) => {
                const active = tagFilter.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTagFilter(tag)}
                    className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
                      active ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground hover:bg-secondary/80"
                    }`}
                  >
                    <span>{tag}</span>
                    <span className={`tabular-nums ${active ? "opacity-90" : "text-muted-foreground"}`}>{count}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="secondary">{clips.length} notes</Badge>
            <Badge variant="outline">{clipCountByVideo} videos</Badge>
            <Badge variant="outline">{allTags.length} tags</Badge>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 text-xs"
              onClick={() => setShowAdmin(value => !value)}
            >
              <Settings2 className="h-3.5 w-3.5" />
              Tag admin
              {showAdmin ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>
        </CardHeader>

        {showAdmin && (
          <CardContent className="border-t pt-3">
            <div className="space-y-3">
              <div className="grid grid-cols-1 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
                <Input
                  value={renameFrom}
                  onChange={event => setRenameFrom(event.target.value)}
                  placeholder="rename from (e.g. religion.endtimes)"
                  className="h-8 font-mono text-xs"
                />
                <Input
                  value={renameTo}
                  onChange={event => setRenameTo(event.target.value)}
                  placeholder="rename to (e.g. religion.end-times)"
                  className="h-8 font-mono text-xs"
                />
                <div className="flex items-center gap-2">
                  <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={renameDescendants}
                      onChange={event => setRenameDescendants(event.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    incl. descendants
                  </label>
                  <Button size="sm" onClick={renameTag} disabled={!renameFrom.trim() || !renameTo.trim()}>
                    Rename / merge
                  </Button>
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-xs text-muted-foreground">All tags ({allTags.length}). Click × to remove globally.</p>
                <div className="flex flex-wrap gap-1.5">
                  {allTags.map(({ tag, count }) => (
                    <span
                      key={tag}
                      className="inline-flex items-center gap-1 rounded-md border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      <span>{tag}</span>
                      <span className="tabular-nums text-muted-foreground">{count}</span>
                      <button
                        type="button"
                        onClick={() => deleteTagGlobal(tag, false)}
                        title="Remove tag from all notes"
                        className="-mr-0.5 inline-flex h-3 w-3 items-center justify-center rounded-sm text-destructive hover:bg-destructive/10"
                        aria-label={`Remove tag ${tag} globally`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {!allTags.length && <span className="text-xs text-muted-foreground">No tags yet.</span>}
                </div>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* 2-pane: sidebar list + detail pane. On narrow widths stacks
          vertically — the user picks a note from the top list, the detail
          renders below. */}
      <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-2">
          <div className="flex items-center gap-1.5">
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="recent" className="text-xs">Recent first</SelectItem>
                <SelectItem value="created" className="text-xs">Oldest first</SelectItem>
                <SelectItem value="title" className="text-xs">Title A–Z</SelectItem>
                <SelectItem value="anchors" className="text-xs">Most anchors</SelectItem>
              </SelectContent>
            </Select>
            <Select value={anchorFilter} onValueChange={(v) => setAnchorFilter(v as AnchorFilter)}>
              <SelectTrigger className="h-8 w-[140px] text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">All notes</SelectItem>
                <SelectItem value="anchored" className="text-xs">Anchored only</SelectItem>
                <SelectItem value="standalone" className="text-xs">Standalone only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1 max-h-[calc(100vh-260px)] overflow-y-auto rounded-md border bg-card p-1">
            {visibleClips.length === 0 && (
              <div className="p-4 text-center text-xs text-muted-foreground">No notes match these filters.</div>
            )}
            {visibleClips.map((c) => {
              const active = c.id === selectedId;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`block w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-secondary ${active ? "bg-secondary" : ""}`}
                >
                  <div className="line-clamp-2 text-sm font-medium leading-tight">{c.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                    <span>
                      {c.anchors.length === 0
                        ? "standalone"
                        : c.anchors.length === 1
                          ? "1 anchor"
                          : `${c.anchors.length} anchors`}
                    </span>
                    {c.tags.length > 0 && <span>· {c.tags.length} tag{c.tags.length === 1 ? "" : "s"}</span>}
                    <span className="ml-auto opacity-60">{c.created_at.slice(5, 10)}</span>
                  </div>
                  {c.note && (
                    <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{c.note}</div>
                  )}
                </button>
              );
            })}
          </div>
        </aside>

        <section className="min-w-0">
          {!selectedClip ? (
            <Card>
              <CardContent className="p-6 text-center text-sm text-muted-foreground">
                {clips.length === 0
                  ? <>No notes yet. Click <strong>+ New note</strong> above to write one — or save a citation from the AI page.</>
                  : "Pick a note on the left."}
              </CardContent>
            </Card>
          ) : (
            <NoteDetailPane
              clip={selectedClip}
              titleDraft={titleDraft[selectedClip.id] ?? selectedClip.title}
              bodyDraft={bodyDraft[selectedClip.id] ?? selectedClip.note ?? ""}
              onTitleChange={(v) => setTitleDraft((m) => ({ ...m, [selectedClip.id]: v }))}
              onBodyChange={(v) => setBodyDraft((m) => ({ ...m, [selectedClip.id]: v }))}
              onTitleBlur={() => saveTitleInline(selectedClip)}
              onBodyBlur={() => saveBodyInline(selectedClip)}
              editingTags={editingTagsForClipId === selectedClip.id}
              onEditTagsStart={() => setEditingTagsForClipId(selectedClip.id)}
              onEditTagsDone={() => setEditingTagsForClipId(null)}
              onTagsChange={(tags) => updateClipTags(selectedClip, tags)}
              allTags={allTags}
              onLoadTags={loadTags}
              onTagChipClick={toggleTagFilter}
              onPlayAnchor={openAnchor}
              onRemoveAnchor={(a) => removeAnchor(selectedClip, a)}
              onAddAnchor={() => setAddAnchorFor(selectedClip)}
              links={linksByClipId[selectedClip.id] || []}
              onRemoveLink={(link) => removeLink(link, selectedClip.id)}
              onAddLink={() => openLinkPicker(selectedClip)}
              onDelete={() => deleteClip(selectedClip)}
            />
          )}
        </section>
      </div>

      <VideoDrawer
        open={drawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
        onOpenChange={setDrawerOpen}
      />

      {addAnchorFor && (
        <AddAnchorDialog
          note={addAnchorFor}
          onClose={() => setAddAnchorFor(null)}
          onSaved={() => {
            setAddAnchorFor(null);
            loadData();
            toast({ title: "Anchor added" });
          }}
        />
      )}

      {newNoteOpen && (
        <NoteEditorDialog
          mode="create"
          allTags={allTags}
          onLoadTags={loadTags}
          onClose={() => setNewNoteOpen(false)}
          onSaved={() => {
            setNewNoteOpen(false);
            loadData();
            toast({ title: "Note created" });
          }}
        />
      )}

      {editingNote && (
        <NoteEditorDialog
          mode="edit"
          note={editingNote}
          allTags={allTags}
          onLoadTags={loadTags}
          onClose={() => setEditingNote(null)}
          onSaved={() => {
            setEditingNote(null);
            loadData();
            toast({ title: "Note updated" });
          }}
        />
      )}

      <Sheet open={!!linkPickerSourceId} onOpenChange={open => { if (!open) closeLinkPicker(); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="text-base">Link a clip</SheetTitle>
            <SheetDescription>
              Connect this clip to another. Symmetric kinds (same claim, contradicts, same scripture) auto-mirror; "follow-up" and "context" stay one-way.
            </SheetDescription>
          </SheetHeader>

          {linkPickerSource && (
            <div className="mt-4 space-y-4">
              <div className="rounded-md border bg-muted/40 p-3">
                <div className="text-xs font-medium text-muted-foreground">From</div>
                <div className="mt-1 text-sm font-medium line-clamp-2">{linkPickerSource.title}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {formatTimestamp(linkPickerSource.start_seconds)} - {formatTimestamp(linkPickerSource.end_seconds)} · {linkPickerSource.channel_name || linkPickerSource.channel_id}
                </div>
                <p className="mt-2 line-clamp-3 text-sm">{linkPickerSource.quote}</p>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Relationship</label>
                <Select value={linkPickerKind} onValueChange={value => setLinkPickerKind(value as ClipLinkKind)}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {LINK_KINDS.map(kind => (
                      <SelectItem key={kind.value} value={kind.value}>
                        {kind.label}
                        {SYMMETRIC_KINDS.has(kind.value) ? " (mutual)" : " (one-way)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="link-note">Optional note</label>
                <Input
                  id="link-note"
                  value={linkPickerNote}
                  onChange={event => setLinkPickerNote(event.target.value)}
                  placeholder="Why are these linked?"
                  className="mt-1.5"
                />
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground" htmlFor="link-search">Find target clip</label>
                <div className="relative mt-1.5">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="link-search"
                    value={linkPickerQuery}
                    onChange={event => {
                      setLinkPickerQuery(event.target.value);
                      searchClipsForPicker(event.target.value);
                    }}
                    placeholder="Search by title, quote, channel..."
                    className="h-9 pl-8"
                  />
                </div>

                <div className="mt-2 max-h-[44vh] overflow-y-auto rounded-md border">
                  {linkPickerSearching && (
                    <p className="p-3 text-sm text-muted-foreground">Searching…</p>
                  )}
                  {!linkPickerSearching && linkPickerResults.length === 0 && linkPickerQuery && (
                    <p className="p-3 text-sm text-muted-foreground">No notes match.</p>
                  )}
                  {!linkPickerSearching && !linkPickerQuery && (
                    <p className="p-3 text-sm text-muted-foreground">Type to search your saved notes.</p>
                  )}
                  {linkPickerResults.map(target => (
                    <button
                      key={target.id}
                      type="button"
                      disabled={linkPickerSaving}
                      onClick={() => saveLink(target)}
                      className="block w-full border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent disabled:opacity-50"
                    >
                      <div className="font-medium line-clamp-1">{target.title}</div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {target.channel_name || target.channel_id} · {formatTimestamp(target.start_seconds)} - {formatTimestamp(target.end_seconds)}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5">{target.quote}</p>
                      {target.tags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {target.tags.map(tag => (
                            <TagChip key={tag} tag={tag} variant="outline" />
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

interface ClipLinksProps {
  clipId: string;
  links: ClipLink[];
  onRemove: (link: ClipLink) => void;
  onAdd: () => void;
}

function ClipLinks({ links, onRemove, onAdd }: ClipLinksProps) {
  return (
    <div className="space-y-1.5">
      {links.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {links.map(link => {
            const arrow = link.direction === "outgoing" ? "→" : "←";
            const isMutual = SYMMETRIC_KINDS.has(link.kind);
            return (
              <span
                key={`${link.from_clip_id}:${link.to_clip_id}:${link.kind}`}
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted px-1.5 py-0.5 text-[11px]"
                title={link.note ?? undefined}
              >
                <Badge variant={isMutual ? "secondary" : "outline"} className="h-4 px-1 text-[10px]">
                  {arrow} {kindLabel(link.kind)}
                </Badge>
                <span className="truncate text-muted-foreground">{link.other.title}</span>
                <button
                  type="button"
                  aria-label="Remove link"
                  onClick={() => onRemove(link)}
                  className="-mr-0.5 inline-flex h-3 w-3 items-center justify-center rounded-sm text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px] text-muted-foreground"
        onClick={onAdd}
      >
        <LinkIcon className="h-3 w-3" />
        {links.length ? "Add another link" : "+ Link to another clip"}
      </Button>
    </div>
  );
}

interface AnchorListProps {
  anchors: ClipAnchor[];
  onPlay: (anchor: ClipAnchor) => void;
  onRemove: (anchor: ClipAnchor) => void;
  onAdd: () => void;
}

function AnchorList({ anchors, onPlay, onRemove, onAdd }: AnchorListProps) {
  return (
    <div className="space-y-1.5">
      {anchors.length > 1 && (
        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {anchors.length} anchors
        </div>
      )}
      {anchors.length === 0 && (
        <div className="rounded-md border border-dashed bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          Standalone note — no anchors yet. Add one to link this thought to a video moment.
        </div>
      )}
      {anchors.map((a) => {
        const isDoc = !!a.document_id;
        return (
          <div key={a.ordinal} className="rounded-md border bg-muted/30 px-2.5 py-1.5">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={(isDoc ? a.doc_title : a.video_title) ?? ""}>
                {isDoc ? (a.doc_title ?? "(missing doc)") : (a.video_title ?? "(unknown video)")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                disabled={isDoc ? !a.doc_rel_path : !a.video_path}
                onClick={() => onPlay(a)}
                title={isDoc ? "Open in Docs viewer" : (a.video_path ? "Play at this moment" : "No saved video file")}
              >
                <Play className="h-3 w-3" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(a)}
                title="Remove this anchor"
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
              {isDoc ? (
                <>
                  <span className="inline-flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    doc
                  </span>
                  <span className="font-mono truncate" title={a.doc_rel_path ?? ""}>{a.doc_rel_path}</span>
                  <span>
                    {a.doc_start_char != null && a.doc_end_char != null
                      ? `chars ${a.doc_start_char}–${a.doc_end_char}`
                      : "whole doc"}
                  </span>
                </>
              ) : (
                <>
                  <span>{a.channel_name || a.channel_id}</span>
                  {a.upload_date && (
                    <span className="inline-flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatUploadDate(a.upload_date)}
                    </span>
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {a.start_seconds == null ? "whole video" : `${formatTimestamp(a.start_seconds)} - ${formatTimestamp(a.end_seconds ?? a.start_seconds)}`}
                  </span>
                </>
              )}
            </div>
            {a.excerpt && (
              <p className="mt-1 text-[12px] italic leading-5 text-muted-foreground">"{a.excerpt}"</p>
            )}
          </div>
        );
      })}
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px] text-muted-foreground"
        onClick={onAdd}
      >
        <Plus className="h-3 w-3" />
        Add anchor
      </Button>
    </div>
  );
}

interface VideoOption {
  video_id: string;
  channel_id: string;
  title: string;
  channel_name: string | null;
  upload_date: string | null;
}

interface AddAnchorDialogProps {
  note: ClipEntry;
  onClose: () => void;
  onSaved: () => void;
}

function AddAnchorDialog({ note, onClose, onSaved }: AddAnchorDialogProps) {
  const { toast } = useToast();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VideoOption[]>([]);
  const [picked, setPicked] = useState<VideoOption | null>(null);
  const [searching, setSearching] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [whole, setWhole] = useState(false);
  const [saving, setSaving] = useState(false);

  // Lightweight video search via the existing pipeline queue list.
  // Filters on the title field; capped at 25 results to keep the dropdown
  // tidy on archives with hundreds of videos.
  useEffect(() => {
    const handle = setTimeout(async () => {
      if (!query.trim()) { setResults([]); return; }
      setSearching(true);
      try {
        const r = await apiRequest("GET", `/api/pipeline/queue?status=complete&q=${encodeURIComponent(query.trim())}&limit=25`);
        const data = await r.json() as { recent: Array<VideoOption> };
        setResults(data.recent ?? []);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [query]);

  const save = async () => {
    if (!picked) return;
    setSaving(true);
    try {
      const startNum = whole ? null : (start.trim() ? Number(start) : 0);
      const endNum = whole ? null : (end.trim() ? Number(end) : startNum);
      await apiRequest("POST", `/api/clips/${note.id}/anchors`, {
        videoId: picked.video_id,
        channelId: picked.channel_id,
        startSeconds: startNum,
        endSeconds: endNum,
        excerpt: excerpt.trim() || null,
      });
      onSaved();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Add anchor failed", description: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm" onClick={onClose}>
      <Card className="w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Plus className="h-4 w-4" /> Add anchor to "{note.title}"
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Search videos</label>
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type part of the video title…"
              className="text-sm"
            />
          </div>

          {results.length > 0 && !picked && (
            <div className="max-h-48 overflow-y-auto rounded-md border">
              {results.map((v) => (
                <button
                  key={`${v.channel_id}:${v.video_id}`}
                  onClick={() => setPicked(v)}
                  className="block w-full border-b px-2.5 py-1.5 text-left last:border-0 hover:bg-secondary"
                >
                  <div className="truncate text-sm">{v.title}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {v.channel_name || v.channel_id} {v.upload_date ? `· ${formatUploadDate(v.upload_date)}` : ""}
                  </div>
                </button>
              ))}
            </div>
          )}

          {searching && <div className="text-xs text-muted-foreground">Searching…</div>}

          {picked && (
            <div className="space-y-3 rounded-md border bg-muted/30 p-2.5">
              <div className="flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{picked.title}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {picked.channel_name || picked.channel_id}
                  </div>
                </div>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setPicked(null)}>
                  Change
                </Button>
              </div>

              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={whole} onChange={(e) => setWhole(e.target.checked)} />
                Anchor to the whole video (no specific moment)
              </label>

              {!whole && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">Start (seconds)</label>
                    <Input
                      type="number"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                      placeholder="0"
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground">End (seconds)</label>
                    <Input
                      type="number"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                      placeholder="optional"
                      className="text-sm"
                    />
                  </div>
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Excerpt (optional — transcript text at this moment)</label>
                <textarea
                  value={excerpt}
                  onChange={(e) => setExcerpt(e.target.value)}
                  rows={3}
                  className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={!picked || saving}>
              {saving ? "Adding…" : "Add anchor"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface NoteEditorDialogProps {
  mode: "create" | "edit";
  note?: ClipEntry;
  allTags: TagCount[];
  onLoadTags: () => void;
  onClose: () => void;
  onSaved: () => void;
}

function NoteEditorDialog({ mode, note, allTags, onLoadTags, onClose, onSaved }: NoteEditorDialogProps) {
  const { toast } = useToast();
  const [title, setTitle] = useState(note?.title ?? "");
  const [body, setBody] = useState(note?.note ?? "");
  const [tags, setTags] = useState<string[]>(note?.tags ?? []);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!title.trim()) {
      toast({ variant: "destructive", title: "Title required" });
      return;
    }
    setSaving(true);
    try {
      if (mode === "create") {
        // Standalone note — no anchors. Add them later via "+ Add anchor"
        // on the note card or via "+ Add to note" in the VideoDrawer.
        await apiRequest("POST", "/api/clips", {
          title: title.trim(),
          note: body.trim() || null,
          tags,
          anchors: [],
        });
      } else if (note) {
        await apiRequest("PATCH", `/api/clips/${note.id}`, {
          title: title.trim(),
          note: body.trim() || null,
        });
        // Tags update is its own endpoint.
        const sameTags = tags.length === note.tags.length && tags.every((t) => note.tags.includes(t));
        if (!sameTags) {
          await apiRequest("PATCH", `/api/clips/${note.id}/tags`, { tags });
        }
      }
      onSaved();
    } catch (error: any) {
      toast({ variant: "destructive", title: "Save failed", description: error.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm" onClick={onClose}>
      <Card className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            {mode === "create" ? <Plus className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            {mode === "create" ? "New note" : "Edit note"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Title</label>
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className="text-sm" placeholder="Short summary of the thought" />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              placeholder="Type the thought here. Anchor it to videos later as evidence."
              className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Tags</label>
            <TagPicker value={tags} onChange={setTags} options={allTags} size="sm" placeholder="Pick or add tags…" onOpen={onLoadTags} />
          </div>
          {mode === "create" && (
            <div className="text-[11px] text-muted-foreground">
              You can save without anchoring to a video. Add anchors later from the note card, or from the VideoDrawer's "+ Add to note" button while watching.
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={saving || !title.trim()}>
              {saving ? "Saving…" : (mode === "create" ? "Create" : "Save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface NoteDetailPaneProps {
  clip: ClipEntry;
  titleDraft: string;
  bodyDraft: string;
  onTitleChange: (v: string) => void;
  onBodyChange: (v: string) => void;
  onTitleBlur: () => void;
  onBodyBlur: () => void;
  editingTags: boolean;
  onEditTagsStart: () => void;
  onEditTagsDone: () => void;
  onTagsChange: (tags: string[]) => void;
  allTags: TagCount[];
  onLoadTags: () => void;
  onTagChipClick: (tag: string) => void;
  onPlayAnchor: (anchor: ClipAnchor) => void;
  onRemoveAnchor: (anchor: ClipAnchor) => void;
  onAddAnchor: () => void;
  links: ClipLink[];
  onRemoveLink: (link: ClipLink) => void;
  onAddLink: () => void;
  onDelete: () => void;
}

function NoteDetailPane({
  clip, titleDraft, bodyDraft, onTitleChange, onBodyChange, onTitleBlur, onBodyBlur,
  editingTags, onEditTagsStart, onEditTagsDone, onTagsChange, allTags, onLoadTags, onTagChipClick,
  onPlayAnchor, onRemoveAnchor, onAddAnchor,
  links, onRemoveLink, onAddLink,
  onDelete,
}: NoteDetailPaneProps) {
  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start gap-2">
          <Input
            value={titleDraft}
            onChange={(e) => onTitleChange(e.target.value)}
            onBlur={onTitleBlur}
            placeholder="Note title"
            className="border-transparent bg-transparent px-2 text-base font-semibold focus-visible:border-input"
          />
          <Button size="sm" variant="ghost" onClick={onDelete} title="Delete note">
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>

        <textarea
          value={bodyDraft}
          onChange={(e) => onBodyChange(e.target.value)}
          onBlur={onBodyBlur}
          rows={6}
          placeholder="Type your thought here. Anchor it to videos as evidence below."
          className="flex w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          {clip.tags.map((tag) => (
            <TagChip key={tag} tag={tag} variant="outline" onClick={() => onTagChipClick(tag)} />
          ))}
          {editingTags ? (
            <>
              <TagPicker
                value={clip.tags}
                onChange={onTagsChange}
                options={allTags}
                size="sm"
                onOpen={onLoadTags}
                quote={clip.quote}
              />
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onEditTagsDone}>
                Done
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={onEditTagsStart}
            >
              {clip.tags.length ? "Edit tags" : "+ Add tags"}
            </Button>
          )}
        </div>

        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {clip.anchors.length === 0 ? "Anchors (none)" : `Anchors (${clip.anchors.length})`}
          </div>
          <AnchorList
            anchors={clip.anchors}
            onPlay={onPlayAnchor}
            onRemove={onRemoveAnchor}
            onAdd={onAddAnchor}
          />
        </div>

        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            Linked notes {links.length > 0 && <span className="opacity-60">({links.length})</span>}
          </div>
          <ClipLinks
            clipId={clip.id}
            links={links}
            onRemove={onRemoveLink}
            onAdd={onAddLink}
          />
        </div>
      </CardContent>
    </Card>
  );
}
