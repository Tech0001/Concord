import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useCategory } from "@/hooks/use-category";
import {
  Binoculars, Check, Download, Inbox, Loader2, Pencil, Plus, RefreshCw, Trash2, X,
} from "lucide-react";

interface Watcher {
  id: number;
  label: string;
  phrase_variants: string[];
  allowed_channels: string[] | null;
  blocked_channels: string[] | null;
  enabled: boolean;
  auto_queue: boolean;
  poll_interval_hours: number;
  last_polled_at: string | null;
  last_error: string | null;
  category: "personal" | "work";
}

interface InboxEntry {
  watcher_id: number;
  video_id: string;
  channel_id: string;
  channel_name: string | null;
  title: string;
  description: string | null;
  thumbnail_url: string | null;
  published_at: string | null;
  found_at: string;
  status: "new" | "queued" | "dismissed";
}

interface WatcherDraft {
  id?: number;
  label: string;
  phrase_variants: string;
  allowed_channels: string;
  blocked_channels: string;
  enabled: boolean;
  auto_queue: boolean;
  poll_interval_hours: number;
  category: "personal" | "work";
}

const EMPTY_DRAFT: WatcherDraft = {
  label: "",
  phrase_variants: "",
  allowed_channels: "",
  blocked_channels: "",
  enabled: true,
  auto_queue: false,
  poll_interval_hours: 24,
  category: "personal",
};

function parseList(s: string): string[] {
  return s.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
}

export default function Watchers() {
  const { toast } = useToast();
  const { category: headerCategory, serverCategory } = useCategory();
  const [watchers, setWatchers] = useState<Watcher[]>([]);
  const [inbox, setInbox] = useState<InboxEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<WatcherDraft | null>(null);
  const [polling, setPolling] = useState<Record<number, boolean>>({});

  const load = async () => {
    setLoading(true);
    try {
      const wUrl = serverCategory
        ? `/api/youtube/watchers?category=${serverCategory}`
        : "/api/youtube/watchers";
      const iUrl = serverCategory
        ? `/api/youtube/inbox?category=${serverCategory}`
        : "/api/youtube/inbox";
      const [wRes, iRes] = await Promise.all([
        apiRequest("GET", wUrl),
        apiRequest("GET", iUrl),
      ]);
      const wData = await wRes.json() as { watchers?: Watcher[] };
      const iData = await iRes.json() as { entries?: InboxEntry[] };
      setWatchers(wData.watchers ?? []);
      setInbox(iData.entries ?? []);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Load failed", description: err.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [serverCategory]);

  const saveDraft = async () => {
    if (!draft) return;
    const body = {
      label: draft.label,
      phrase_variants: parseList(draft.phrase_variants),
      allowed_channels: parseList(draft.allowed_channels),
      blocked_channels: parseList(draft.blocked_channels),
      enabled: draft.enabled,
      auto_queue: draft.auto_queue,
      poll_interval_hours: draft.poll_interval_hours,
      category: draft.category,
    };
    try {
      if (draft.id) {
        await apiRequest("PUT", `/api/youtube/watchers/${draft.id}`, body);
      } else {
        await apiRequest("POST", "/api/youtube/watchers", body);
      }
      setDraft(null);
      await load();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Save failed", description: err.message });
    }
  };

  const deleteWatcher = async (w: Watcher) => {
    if (!confirm(`Delete watcher "${w.label}"? Inbox entries from this watcher will also be removed.`)) return;
    try {
      await apiRequest("DELETE", `/api/youtube/watchers/${w.id}`);
      await load();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Delete failed", description: err.message });
    }
  };

  const togglePatch = async (w: Watcher, patch: Partial<Watcher>) => {
    try {
      await apiRequest("PUT", `/api/youtube/watchers/${w.id}`, patch);
      await load();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Update failed", description: err.message });
    }
  };

  const pollNow = async (w: Watcher) => {
    setPolling(s => ({ ...s, [w.id]: true }));
    try {
      const r = await apiRequest("POST", `/api/youtube/watchers/${w.id}/poll`, {});
      const data = await r.json() as { inserted: number; queued: number };
      toast({ title: `Polled "${w.label}"`, description: `${data.inserted} new (${data.queued} auto-queued)` });
      await load();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Poll failed", description: err.message });
    } finally {
      setPolling(s => ({ ...s, [w.id]: false }));
    }
  };

  const queueInbox = async (e: InboxEntry) => {
    try {
      await apiRequest("POST", `/api/youtube/inbox/${e.watcher_id}/${e.video_id}/queue`, {});
      toast({ title: "Queued", description: e.title });
      await load();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Queue failed", description: err.message });
    }
  };

  const dismissInbox = async (e: InboxEntry) => {
    try {
      await apiRequest("POST", `/api/youtube/inbox/${e.watcher_id}/${e.video_id}/dismiss`, {});
      await load();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Dismiss failed", description: err.message });
    }
  };

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Binoculars className="h-5 w-5" />
          Watchers
        </h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setDraft({
            ...EMPTY_DRAFT,
            // Default to the current header toggle so users don't have to
            // remember to set it; falls back to 'personal' when toggle is 'both'.
            category: headerCategory === "work" ? "work" : "personal",
          })}>
            <Plus className="h-4 w-4" />
            New watcher
          </Button>
        </div>
      </div>

      {/* Inbox at top — new matches awaiting review */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Inbox className="h-4 w-4" />
            Inbox ({inbox.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {inbox.length === 0 && (
            <p className="text-sm text-muted-foreground">No new matches. Enabled watchers will fill this list when their next poll fires.</p>
          )}
          {inbox.map((e) => {
            const watcher = watchers.find(w => w.id === e.watcher_id);
            return (
              <div key={`${e.watcher_id}-${e.video_id}`} className="flex gap-3 rounded border bg-card p-2">
                {e.thumbnail_url && (
                  <img src={e.thumbnail_url} alt="" className="h-16 w-28 flex-shrink-0 rounded object-cover" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium">{e.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{e.channel_name ?? e.channel_id}</span>
                    {e.published_at && <span>· {e.published_at.slice(0, 10)}</span>}
                    {watcher && <Badge variant="outline" className="text-[10px]">{watcher.label}</Badge>}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Button size="sm" onClick={() => queueInbox(e)}>
                    <Download className="h-3.5 w-3.5" />
                    Queue
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => dismissInbox(e)}>
                    <X className="h-3.5 w-3.5" />
                    Dismiss
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Watcher list */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Saved watchers ({watchers.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {watchers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No watchers yet. Run a search on the Discover page and click "Save as watcher", or use "New watcher" above.
            </p>
          )}
          {watchers.map((w) => (
            <div key={w.id} className="rounded border bg-card p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{w.label}</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {w.phrase_variants.length} phrase{w.phrase_variants.length === 1 ? "" : "s"}
                    </Badge>
                    {w.auto_queue && <Badge className="text-[10px]">Auto-queue</Badge>}
                    <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                      {w.category ?? "personal"}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
                    {w.phrase_variants.map(v => `"${v}"`).join("  ·  ")}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Every {w.poll_interval_hours}h · {w.last_polled_at
                      ? `last ${w.last_polled_at.replace("T", " ").slice(0, 16)}`
                      : "not yet polled"}
                    {w.last_error && <span className="ml-2 text-destructive">err: {w.last_error}</span>}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">Enabled</span>
                    <Switch
                      checked={w.enabled}
                      onCheckedChange={(v) => togglePatch(w, { enabled: v })}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">Auto-queue</span>
                    <Switch
                      checked={w.auto_queue}
                      onCheckedChange={(v) => togglePatch(w, { auto_queue: v })}
                    />
                  </div>
                </div>
              </div>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="outline" onClick={() => pollNow(w)} disabled={polling[w.id]}>
                  {polling[w.id]
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <RefreshCw className="h-3.5 w-3.5" />}
                  Poll now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDraft({
                    id: w.id,
                    label: w.label,
                    phrase_variants: w.phrase_variants.join("\n"),
                    allowed_channels: (w.allowed_channels ?? []).join("\n"),
                    blocked_channels: (w.blocked_channels ?? []).join("\n"),
                    enabled: w.enabled,
                    auto_queue: w.auto_queue,
                    poll_interval_hours: w.poll_interval_hours,
                    category: w.category ?? "personal",
                  })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteWatcher(w)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Edit / create modal — simple inline form, no Dialog wrapper to
          keep the dependency surface minimal */}
      {draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle className="text-base">{draft.id ? "Edit watcher" : "New watcher"}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Label</label>
                <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">
                  Phrase variants (one per line) — videos are kept only if the title literally contains one of these
                </label>
                <textarea
                  value={draft.phrase_variants}
                  onChange={(e) => setDraft({ ...draft, phrase_variants: e.target.value })}
                  rows={4}
                  className="w-full rounded border bg-background p-2 text-sm"
                  placeholder={`"with John Smith"\n"interview with John Smith"\n"John Smith on"`}
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Allowed channels (optional)</label>
                  <textarea
                    value={draft.allowed_channels}
                    onChange={(e) => setDraft({ ...draft, allowed_channels: e.target.value })}
                    rows={3}
                    className="w-full rounded border bg-background p-2 text-xs"
                    placeholder="Channel name or UC... id, one per line"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Blocked channels (optional)</label>
                  <textarea
                    value={draft.blocked_channels}
                    onChange={(e) => setDraft({ ...draft, blocked_channels: e.target.value })}
                    rows={3}
                    className="w-full rounded border bg-background p-2 text-xs"
                    placeholder="Useful for filtering clickbait/spam channels"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Poll interval (hours)</label>
                  <Input
                    type="number"
                    min={1}
                    value={draft.poll_interval_hours}
                    onChange={(e) => setDraft({ ...draft, poll_interval_hours: Math.max(1, Number(e.target.value) || 24) })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Category</label>
                  <Select
                    value={draft.category}
                    onValueChange={(v) => setDraft({ ...draft, category: v as "personal" | "work" })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="personal">Personal</SelectItem>
                      <SelectItem value="work">Work</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex items-center gap-2">
                  <Switch
                    checked={draft.enabled}
                    onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
                  />
                  <span className="text-xs">Enabled</span>
                </label>
                <label className="flex items-center gap-2">
                  <Switch
                    checked={draft.auto_queue}
                    onCheckedChange={(v) => setDraft({ ...draft, auto_queue: v })}
                  />
                  <span className="text-xs">Auto-queue hits</span>
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button variant="ghost" onClick={() => setDraft(null)}>
                  <X className="h-4 w-4" />
                  Cancel
                </Button>
                <Button onClick={saveDraft}>
                  <Check className="h-4 w-4" />
                  Save
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
