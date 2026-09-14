import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { FileText, Loader2, NotebookPen, Plus, Search, Sparkles, SplitSquareHorizontal, Trash2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Markdown, makeDocImageResolver } from "@/components/Markdown";
import { useToast } from "@/hooks/use-toast";
import { loadCompareSources, removeCompareSource, saveCompareSources, type CompareSource } from "@/lib/compare-sources";

interface SearchResult { id: string; type: string; title: string; subtitle: string; source?: CompareSource }
interface LoadedSource { content: string; subtitle: string; kind: CompareSource["kind"]; rootId?: string; relPath?: string }

function sourceIdentity(source: CompareSource): string {
  return source.kind === "video" ? `video:${source.channelId}:${source.videoId}` : source.kind === "doc" ? `doc:${source.documentId}` : `note:${source.noteId}`;
}

function sourceHref(source: CompareSource): string {
  if (source.kind === "video") return `/library?video=${encodeURIComponent(source.videoId)}&channel=${encodeURIComponent(source.channelId)}`;
  if (source.kind === "doc") return `/docs?path=${encodeURIComponent(source.relPath)}&rootId=${encodeURIComponent(source.rootId)}`;
  return `/notes?noteId=${encodeURIComponent(source.noteId)}`;
}

export default function Compare() {
  const { toast } = useToast();
  const [sources, setSources] = useState<CompareSource[]>(loadCompareSources);
  const [queries, setQueries] = useState(["", ""]);
  const [results, setResults] = useState<SearchResult[][]>([[], []]);
  const [sharedNote, setSharedNote] = useState(() => typeof window === "undefined" ? "" : window.localStorage.getItem("concord-compare-shared-note-v1") || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onUpdate = () => setSources(loadCompareSources());
    window.addEventListener("concord:compare-updated", onUpdate);
    return () => window.removeEventListener("concord:compare-updated", onUpdate);
  }, []);

  useEffect(() => {
    window.localStorage.setItem("concord-compare-shared-note-v1", sharedNote);
  }, [sharedNote]);

  const search = useCallback(async (index: number, query: string) => {
    setQueries(current => current.map((value, itemIndex) => itemIndex === index ? query : value));
    if (!query.trim()) { setResults(current => current.map((value, itemIndex) => itemIndex === index ? [] : value)); return; }
    const response = await fetch(`/api/command/search?q=${encodeURIComponent(query)}&limit=8`, { cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json() as { results?: SearchResult[] };
    setResults(current => current.map((value, itemIndex) => itemIndex === index ? (data.results || []).filter(item => !!item.source) : value));
  }, []);

  const choose = (index: number, source: CompareSource) => {
    const next = [...sources];
    next[index] = source;
    const deduped = next.filter((item, itemIndex, all) => all.findIndex(other => sourceIdentity(other) === sourceIdentity(item)) === itemIndex).slice(0, 2);
    setSources(deduped); saveCompareSources(deduped);
    setQueries(["", ""]); setResults([[], []]);
  };

  const remove = (index: number) => setSources(removeCompareSource(index));

  const saveResearchNote = async () => {
    if (!sharedNote.trim()) return;
    const anchors: Array<Record<string, string | number | null>> = [];
    for (const source of sources) {
      if (source.kind === "video") anchors.push({ videoId: source.videoId, channelId: source.channelId, startSeconds: 0, endSeconds: null, excerpt: null });
      if (source.kind === "doc") anchors.push({ documentId: source.documentId, docStartChar: null, docEndChar: null, excerpt: null });
    }
    setSaving(true);
    try {
      const title = `Comparison: ${sources.map(source => source.title).join(" ↔ ")}`;
      const response = await fetch("/api/clips", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, note: sharedNote.trim(), anchors }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Save failed");
      setSharedNote("");
      toast({ title: "Comparison saved as a research note", description: anchors.length ? `Linked to ${anchors.length} source${anchors.length === 1 ? "" : "s"}.` : "Saved as a standalone note." });
    } catch (error) {
      toast({ variant: "destructive", title: "Could not save comparison", description: error instanceof Error ? error.message : String(error) });
    } finally { setSaving(false); }
  };

  const aiHref = useMemo(() => {
    const params = new URLSearchParams({
      scope: "compare",
      sources: JSON.stringify(sources),
      title: sources.map(source => source.title).join(" ↔ ") || "Selected sources",
      prompt: `Compare these sources. Identify where they agree, where they differ or contradict one another, the strongest evidence in each, and any important gaps or uncertainties.`,
    });
    return `/ai?${params}`;
  }, [sources]);

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 px-4 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="flex items-center gap-2 text-lg font-semibold"><SplitSquareHorizontal className="h-5 w-5" />Compare sources</h1><p className="mt-1 text-xs text-muted-foreground">Read two sources side by side, keep one shared observation, and ask AI within exactly this pair.</p></div>
        <Link href={sources.length >= 2 ? aiHref : "/compare"}><Button size="sm" disabled={sources.length < 2}><Sparkles className="mr-1.5 h-3.5 w-3.5" />Ask AI to compare</Button></Link>
      </div>

      <div className="grid min-h-[58vh] gap-3 lg:grid-cols-2">
        {[0, 1].map(index => {
          const source = sources[index];
          return source ? <SourcePanel key={sourceIdentity(source)} source={source} onRemove={() => remove(index)} /> : (
            <Card key={index} className="border-dashed">
              <CardContent className="flex h-full min-h-80 flex-col justify-center gap-3 p-6">
                <div className="text-center"><Plus className="mx-auto mb-2 h-6 w-6 text-muted-foreground" /><div className="text-sm font-medium">Choose {index === 0 ? "first" : "second"} source</div><p className="text-xs text-muted-foreground">Videos, audio, documents, and research notes can be compared.</p></div>
                <div className="relative mx-auto w-full max-w-md"><Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input value={queries[index]} onChange={event => void search(index, event.target.value)} className="h-9 pl-8 text-xs" placeholder="Search the archive…" />
                  {results[index].length > 0 && <div className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-xl">{results[index].map(result => <button key={result.id} type="button" className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-accent" onClick={() => choose(index, result.source!)}>{result.type === "doc" ? <FileText className="h-4 w-4 text-blue-500" /> : result.type === "note" ? <NotebookPen className="h-4 w-4 text-amber-500" /> : <Video className="h-4 w-4 text-violet-500" />}<span className="min-w-0"><span className="block truncate text-xs font-medium">{result.title}</span><span className="block truncate text-[10px] text-muted-foreground">{result.subtitle}</span></span></button>)}</div>}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Shared comparison note</CardTitle></CardHeader>
        <CardContent className="space-y-2 pt-0">
          <textarea value={sharedNote} onChange={event => setSharedNote(event.target.value)} rows={5} className="w-full resize-y rounded-md border bg-background p-3 text-sm outline-none focus:ring-1 focus:ring-ring" placeholder="Record agreements, contradictions, questions, and your own conclusion while both sources are visible…" />
          <div className="flex justify-end"><Button size="sm" variant="outline" disabled={!sharedNote.trim() || saving} onClick={() => void saveResearchNote()}>{saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save as research note</Button></div>
        </CardContent>
      </Card>
    </div>
  );
}

function SourcePanel({ source, onRemove }: { source: CompareSource; onRemove: () => void }) {
  const [loaded, setLoaded] = useState<LoadedSource | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (source.kind === "video") {
          const response = await fetch(`/api/videos/library/${encodeURIComponent(source.channelId)}/${encodeURIComponent(source.videoId)}/transcript`, { cache: "no-store" });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Transcript unavailable");
          const text = (data.segments || []).map((segment: any) => `${formatTimestamp(segment.start)}${segment.speaker ? ` · ${segment.speaker}` : ""}\n${segment.text}`).join("\n\n");
          if (!cancelled) setLoaded({ kind: "video", content: text || "No transcript text.", subtitle: `${(data.segments || []).length.toLocaleString()} transcript segments` });
        } else if (source.kind === "doc") {
          const qs = new URLSearchParams({ path: source.relPath, rootId: source.rootId });
          const response = await fetch(`/api/docs/file?${qs}`, { cache: "no-store" });
          if (!response.ok) throw new Error("Document unavailable");
          if (!cancelled) setLoaded({ kind: "doc", content: await response.text(), subtitle: source.relPath, rootId: source.rootId, relPath: source.relPath });
        } else {
          const response = await fetch(`/api/clips/${encodeURIComponent(source.noteId)}`, { cache: "no-store" });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || "Note unavailable");
          const note = data.note || data;
          if (!cancelled) setLoaded({ kind: "note", content: [note.note, note.quote].filter(Boolean).join("\n\n> "), subtitle: `${note.tags?.length || 0} tags · ${note.anchors?.length || 0} anchors` });
        }
      } catch (err) { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); }
    })();
    return () => { cancelled = true; };
  }, [source]);

  const Icon = source.kind === "doc" ? FileText : source.kind === "note" ? NotebookPen : Video;
  return <Card className="flex min-h-0 flex-col overflow-hidden">
    <CardHeader className="shrink-0 border-b p-3"><CardTitle className="flex items-center gap-2 text-sm"><Icon className="h-4 w-4" /><span className="min-w-0 flex-1 truncate">{source.title}</span><Link href={sourceHref(source)}><Button size="sm" variant="ghost" className="h-7 text-xs">Open</Button></Link><Button size="icon" variant="ghost" className="h-7 w-7" onClick={onRemove} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button></CardTitle>{loaded && <div className="truncate text-[10px] text-muted-foreground">{loaded.subtitle}</div>}</CardHeader>
    <CardContent className="min-h-0 flex-1 overflow-y-auto p-4">{error ? <div className="text-xs text-destructive">{error}</div> : !loaded ? <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Loading source…</div> : loaded.kind === "doc" ? <Markdown source={loaded.content} resolveImageSrc={makeDocImageResolver(loaded.rootId, loaded.relPath || "")} /> : <pre className="whitespace-pre-wrap font-sans text-xs leading-5 text-foreground">{loaded.content}</pre>}</CardContent>
  </Card>;
}

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}
