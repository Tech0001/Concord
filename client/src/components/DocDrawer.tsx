import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Columns2, ExternalLink, FileText, Info, Loader2, Maximize2, NotebookPen, PanelRight, Save, Sparkles, SplitSquareHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Markdown, makeDocImageResolver } from "@/components/Markdown";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { pinCompareSource } from "@/lib/compare-sources";

export interface DocDrawerEntry {
  documentId?: string;
  rootId?: string;
  relPath: string;
  title: string;
  excerpt?: string | null;
  subtitle?: string | null;
}

type DrawerMode = "compact" | "wide" | "full";
type DrawerTab = "read" | "notes" | "details";
const MODE_KEY = "concord-doc-drawer-mode-v1";

interface DocumentWorkspace {
  document: {
    id: string; title: string; rel_path: string; root_id: string | null; bytes: number; mtime_ms: number;
    author?: string | null; speaker_name?: string | null; category: string; starred: number; created_at: string; updated_at: string;
  };
  root: { id: string; path: string; label: string } | null;
  notes: { id: string; title: string; note: string | null; quote: string; tags: string[]; updated_at: string }[];
  embeddings: { model: string; chunks: number }[];
}

function storedMode(): DrawerMode {
  if (typeof window === "undefined") return "wide";
  const value = localStorage.getItem(MODE_KEY);
  return value === "compact" || value === "full" || value === "wide" ? value : "wide";
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function DocDrawer({ open, onOpenChange, doc }: { open: boolean; onOpenChange: (open: boolean) => void; doc: DocDrawerEntry | null }) {
  const { toast } = useToast();
  const markdownRef = useRef<HTMLDivElement | null>(null);
  const [content, setContent] = useState("");
  const [workspace, setWorkspace] = useState<DocumentWorkspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<DrawerMode>(storedMode);
  const [tab, setTab] = useState<DrawerTab>("read");
  const [selection, setSelection] = useState("");
  const [selectionNote, setSelectionNote] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!doc) return;
    setLoading(true); setError(null);
    try {
      const qs = new URLSearchParams({ path: doc.relPath });
      if (doc.rootId !== undefined) qs.set("rootId", doc.rootId);
      const requests: Promise<Response>[] = [apiRequest("GET", `/api/docs/file?${qs}`)];
      if (doc.documentId) requests.push(apiRequest("GET", `/api/docs/${encodeURIComponent(doc.documentId)}/workspace`));
      const [fileResponse, workspaceResponse] = await Promise.all(requests);
      if (!fileResponse.ok) throw new Error((await fileResponse.json().catch(() => ({}))).error || `HTTP ${fileResponse.status}`);
      setContent(await fileResponse.text());
      setWorkspace(workspaceResponse?.ok ? await workspaceResponse.json() : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setLoading(false); }
  };

  useEffect(() => {
    if (!open || !doc) { setContent(""); setWorkspace(null); setSelection(""); setSelectionNote(""); return; }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc?.documentId, doc?.relPath, doc?.rootId]);

  useEffect(() => {
    if (!open || !content || !doc?.excerpt) return;
    const needle = doc.excerpt.slice(0, 60).trim();
    if (!needle) return;
    const id = requestAnimationFrame(() => {
      const root = markdownRef.current?.querySelector(".markdown-body");
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if ((node.nodeValue || "").includes(needle)) {
          node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
          node.parentElement?.classList.add("docs-cite-highlight");
          break;
        }
      }
    });
    return () => cancelAnimationFrame(id);
  }, [open, content, doc?.excerpt]);

  const captureSelection = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !markdownRef.current?.contains(selected.anchorNode)) return;
    const text = selected.toString().trim();
    if (text) { setSelection(text.slice(0, 5000)); setSelectionNote(""); }
  };

  const saveSelection = async () => {
    if (!doc?.documentId || !selection) return;
    setSaving(true);
    try {
      const start = Math.max(0, content.indexOf(selection));
      await apiRequest("POST", "/api/clips", {
        title: doc.title,
        note: selectionNote.trim() || null,
        anchors: [{ documentId: doc.documentId, docStartChar: start, docEndChar: start + selection.length, excerpt: selection }],
      });
      toast({ title: "Selection saved as a research note" });
      setSelection(""); setSelectionNote("");
      await load();
    } catch (err) {
      toast({ variant: "destructive", title: "Could not save selection", description: err instanceof Error ? err.message : String(err) });
    } finally { setSaving(false); }
  };

  const changeMode = (next: DrawerMode) => { setMode(next); localStorage.setItem(MODE_KEY, next); };
  const details = workspace?.document;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-doc-drawer
        className={cn("flex w-full flex-col overflow-hidden p-0 transition-[max-width]", mode === "compact" ? "sm:max-w-2xl" : mode === "wide" ? "sm:max-w-[92vw]" : "sm:max-w-none")}
      >
        {doc && <>
          <SheetHeader className="shrink-0 border-b px-4 py-3 pr-12">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <SheetTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4 shrink-0 text-blue-500" /><span className="line-clamp-2">{doc.title}</span></SheetTitle>
                <SheetDescription className="mt-0.5 truncate font-mono text-[11px]" title={doc.relPath}>{doc.subtitle ? `${doc.subtitle} · ` : ""}{doc.relPath}</SheetDescription>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <div className="hidden items-center rounded-md border p-0.5 sm:flex">
                  <Button size="icon" variant={mode === "compact" ? "secondary" : "ghost"} className="h-6 w-6" onClick={() => changeMode("compact")} title="Compact"><PanelRight className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant={mode === "wide" ? "secondary" : "ghost"} className="h-6 w-6" onClick={() => changeMode("wide")} title="Wide"><Columns2 className="h-3.5 w-3.5" /></Button>
                  <Button size="icon" variant={mode === "full" ? "secondary" : "ghost"} className="h-6 w-6" onClick={() => changeMode("full")} title="Full screen"><Maximize2 className="h-3.5 w-3.5" /></Button>
                </div>
                {doc.documentId && <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => { pinCompareSource({ kind: "doc", documentId: doc.documentId!, rootId: doc.rootId || "", relPath: doc.relPath, title: doc.title }); toast({ title: "Pinned for comparison", description: "Open Compare to choose the second source." }); }}><SplitSquareHorizontal className="h-3.5 w-3.5" />Compare</Button>}
                {doc.documentId && <Link href={`/ai?scope=doc&documentId=${encodeURIComponent(doc.documentId)}&title=${encodeURIComponent(doc.title)}`} onClick={() => onOpenChange(false)}><Button size="sm" variant="outline" className="h-7 gap-1 text-xs"><Sparkles className="h-3.5 w-3.5" />Ask AI</Button></Link>}
                <Link href={`/docs?${buildOpenInDocsQs(doc)}`} onClick={() => onOpenChange(false)}><Button size="icon" variant="ghost" className="h-7 w-7" title="Open in Docs"><ExternalLink className="h-3.5 w-3.5" /></Button></Link>
              </div>
            </div>
          </SheetHeader>

          <div className={cn(
            "min-h-0 flex-1 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]",
            mode !== "compact" && "lg:grid lg:overflow-hidden lg:grid-cols-[minmax(260px,0.55fr)_minmax(520px,1.45fr)]",
          )}>
            <aside className={cn("space-y-4 p-4", mode !== "compact" && "lg:overflow-y-auto lg:border-r")}>
              <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs">
                <div className="font-medium">Document workspace</div>
                {workspace?.root && <div className="text-muted-foreground">{workspace.root.label}</div>}
                <div className="break-all font-mono text-[10px] text-muted-foreground">{doc.relPath}</div>
                <div className="flex flex-wrap gap-1.5">
                  {details?.author && <Badge variant="outline">{details.author}</Badge>}
                  {details?.category && <Badge variant="outline">{details.category}</Badge>}
                  {details?.starred ? <Badge>starred</Badge> : null}
                  {details?.bytes != null && <Badge variant="outline">{formatBytes(details.bytes)}</Badge>}
                </div>
              </div>

              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2 text-xs font-medium"><Save className="h-3.5 w-3.5" />Save a passage</div>
                {selection ? <>
                  <blockquote className="max-h-28 overflow-y-auto border-l-2 pl-2 text-xs text-muted-foreground">{selection}</blockquote>
                  <textarea value={selectionNote} onChange={event => setSelectionNote(event.target.value)} rows={3} className="w-full resize-y rounded-md border bg-background p-2 text-xs outline-none focus:ring-1 focus:ring-ring" placeholder="Your note about this passage (optional)…" />
                  <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelection("")}>Clear</Button><Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => void saveSelection()}>{saving && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}Save note</Button></div>
                </> : <p className="text-[11px] leading-5 text-muted-foreground">Select text in the document to capture it as evidence and add your observation without leaving the drawer.</p>}
              </div>

              <div className="rounded-md border p-3 text-xs">
                <div className="font-medium">Research notes</div>
                <div className="mt-1 text-muted-foreground">{workspace?.notes.length || 0} anchored to this document</div>
              </div>
            </aside>

            <section className={cn("min-h-0", mode !== "compact" && "lg:flex lg:flex-col lg:overflow-hidden")}>
              <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
                <TabButton active={tab === "read"} onClick={() => setTab("read")} icon={FileText} label="Read" />
                <TabButton active={tab === "notes"} onClick={() => setTab("notes")} icon={NotebookPen} label="Notes" count={workspace?.notes.length || 0} />
                <TabButton active={tab === "details"} onClick={() => setTab("details")} icon={Info} label="Details" />
              </div>
              <div className={cn("p-5", mode !== "compact" && "lg:min-h-0 lg:flex-1 lg:overflow-y-auto")}>
                {loading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading document…</div>
                  : error ? <div className="text-sm text-destructive">{error}</div>
                  : tab === "read" ? <div ref={markdownRef} onMouseUp={captureSelection}><Markdown source={content} resolveImageSrc={makeDocImageResolver(doc.rootId, doc.relPath)} /></div>
                  : tab === "notes" ? <div className="space-y-2">
                    {(workspace?.notes || []).map(note => <Link key={note.id} href={`/notes?noteId=${encodeURIComponent(note.id)}`} onClick={() => onOpenChange(false)} className="block rounded-md border p-3 hover:bg-muted/40"><div className="text-sm font-medium">{note.title}</div>{note.note && <p className="mt-1 text-xs text-muted-foreground">{note.note}</p>}<blockquote className="mt-2 line-clamp-3 border-l-2 pl-2 text-[11px] text-muted-foreground">{note.quote}</blockquote></Link>)}
                    {!workspace?.notes.length && <div className="rounded-md border border-dashed py-8 text-center text-xs text-muted-foreground">No notes anchored here yet. Select a passage in Read to create one.</div>}
                  </div>
                  : <div className="space-y-3 text-xs">
                    <div className="rounded-md border p-3"><div className="mb-2 font-medium">File</div><dl className="grid grid-cols-[110px_1fr] gap-2 text-muted-foreground"><dt>Root</dt><dd>{workspace?.root?.path || "—"}</dd><dt>Relative path</dt><dd className="break-all font-mono">{doc.relPath}</dd><dt>Size</dt><dd>{details ? formatBytes(details.bytes) : "—"}</dd><dt>Modified</dt><dd>{details ? new Date(details.mtime_ms).toLocaleString() : "—"}</dd><dt>Indexed</dt><dd>{details ? new Date(details.updated_at).toLocaleString() : "—"}</dd></dl></div>
                    <div className="rounded-md border p-3"><div className="mb-2 font-medium">Semantic index</div>{workspace?.embeddings.length ? workspace.embeddings.map(item => <div key={item.model} className="flex justify-between text-muted-foreground"><code>{item.model}</code><span>{item.chunks} chunks</span></div>) : <div className="text-muted-foreground">Not embedded</div>}</div>
                  </div>}
              </div>
            </section>
          </div>
        </>}
      </SheetContent>
    </Sheet>
  );
}

function TabButton({ active, onClick, icon: Icon, label, count }: { active: boolean; onClick: () => void; icon: typeof FileText; label: string; count?: number }) {
  return <Button size="sm" variant={active ? "secondary" : "ghost"} className="h-7 gap-1.5 text-xs" onClick={onClick}><Icon className="h-3.5 w-3.5" />{label}{count !== undefined && <span className="text-[10px] text-muted-foreground">{count}</span>}</Button>;
}

function buildOpenInDocsQs(doc: DocDrawerEntry): string {
  const qs = new URLSearchParams({ path: doc.relPath });
  if (doc.rootId !== undefined) qs.set("rootId", doc.rootId);
  if (doc.excerpt) qs.set("excerpt", doc.excerpt);
  return qs.toString();
}
