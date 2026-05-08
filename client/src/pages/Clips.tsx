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
import {
  Bookmark,
  Calendar,
  ChevronDown,
  ChevronUp,
  Clock,
  Link as LinkIcon,
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
      toast({ variant: "destructive", title: "Clips load failed", description: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [channelId, tagFilter]);

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
    if (!window.confirm(`Remove tag "${tag}"${includeDescendants ? " (with descendants)" : ""} from all clips?`)) return;
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

  const popularTags = allTags.slice(0, POPULAR_LIMIT);

  return (
    <div className="mx-auto max-w-7xl px-4 py-4 space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <CardTitle className="flex items-center gap-2">
              <Bookmark className="h-4 w-4" />
              Clips
            </CardTitle>
            <div className="flex flex-wrap gap-2">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") loadData(); }}
                  placeholder="Search clips and notes"
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
            <Badge variant="secondary">{clips.length} clips</Badge>
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
                        title="Remove tag from all clips"
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

      <div className="space-y-3">
        {clips.map(clip => {
          const editingThis = editingTagsForClipId === clip.id;
          return (
            <Card key={clip.id}>
              <CardContent className="p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 space-y-2">
                    <div>
                      <div className="font-medium line-clamp-2">{clip.title}</div>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span>{clip.channel_name || clip.channel_id}</span>
                        <span className="inline-flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          {formatUploadDate(clip.upload_date)}
                        </span>
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatTimestamp(clip.start_seconds)} - {formatTimestamp(clip.end_seconds)}
                        </span>
                      </div>
                    </div>
                    <p className="text-sm leading-6">{clip.quote}</p>
                    {clip.note && (
                      <p className="rounded-md border bg-muted/50 p-2 text-sm text-muted-foreground">{clip.note}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-1.5">
                      {clip.tags.map(tag => (
                        <TagChip
                          key={tag}
                          tag={tag}
                          variant="outline"
                          onClick={() => toggleTagFilter(tag)}
                        />
                      ))}
                      {editingThis ? (
                        <TagPicker
                          value={clip.tags}
                          onChange={tags => updateClipTags(clip, tags)}
                          options={allTags}
                          size="sm"
                          onOpen={loadTags}
                        />
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px] text-muted-foreground"
                          onClick={() => setEditingTagsForClipId(clip.id)}
                        >
                          {clip.tags.length ? "Edit tags" : "+ Add tags"}
                        </Button>
                      )}
                      {editingThis && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setEditingTagsForClipId(null)}
                        >
                          Done
                        </Button>
                      )}
                    </div>

                    <ClipLinks
                      clipId={clip.id}
                      links={linksByClipId[clip.id] || []}
                      onRemove={link => removeLink(link, clip.id)}
                      onAdd={() => openLinkPicker(clip)}
                    />
                  </div>
                  <div className="flex shrink-0 gap-2 md:justify-end">
                    <Button size="sm" variant="outline" disabled={!clip.video_path} onClick={() => openClip(clip)}>
                      <Play className="h-3 w-3" />
                      Open
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteClip(clip)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {!clips.length && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              No clips match these filters.
            </CardContent>
          </Card>
        )}
      </div>

      <VideoDrawer
        open={drawerOpen}
        video={drawerVideo}
        initialSeconds={drawerSeconds}
        onOpenChange={setDrawerOpen}
      />

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
                    <p className="p-3 text-sm text-muted-foreground">No clips match.</p>
                  )}
                  {!linkPickerSearching && !linkPickerQuery && (
                    <p className="p-3 text-sm text-muted-foreground">Type to search your saved clips.</p>
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
