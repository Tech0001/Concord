import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronLeft, ChevronRight, FileText, FolderOpen, FolderPlus, Loader2, NotebookPen, Pencil, RefreshCw, Search, Sparkles, Star, Trash2, User, X } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import FolderInput from "@/components/FolderInput";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCategory } from "@/hooks/use-category";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
  mtimeMs?: number;
  documentId?: string;
  starred?: number;
  category?: string;
}

interface DocsRoot {
  id: string;
  path: string;
  label: string;
}

interface RootTree {
  root: DocsRoot;
  tree: TreeNode[];
  error?: string;
}

interface DocumentMeta {
  id: string;
  rel_path: string;
  title: string;
  starred: number;
  category: string;
  root_id?: string | null;
  /** Raw frontmatter author (null when none declared). */
  author?: string | null;
  /** Resolved global speaker, when `author` matched a known speaker.
   *  speaker_name/color come from the speakers registry so the chip
   *  matches the transcript-side styling. */
  speaker_id?: string | null;
  speaker_name?: string | null;
  speaker_color?: string | null;
}

interface FileSelection {
  rootId: string;
  path: string;
}

/**
 * /docs — multi-root markdown viewer. Each configured root renders as
 * its own collapsible section in the sidebar; tree nodes within a
 * section share the root's id, which is what makes deep-link URLs +
 * doc-id lookups unambiguous when two roots share a rel_path.
 */
export default function Docs() {
  const { toast } = useToast();
  const { serverCategory } = useCategory();
  const [roots, setRoots] = useState<DocsRoot[]>([]);
  const [rootTrees, setRootTrees] = useState<RootTree[]>([]);
  const [selected, setSelected] = useState<FileSelection | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocumentMeta | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [filter, setFilter] = useState("");

  // "Add root" form state — kept inline so the user can add a new
  // folder without leaving the page.
  const [addingRoot, setAddingRoot] = useState(false);
  const [draftRootPath, setDraftRootPath] = useState("");

  const loadConfig = useCallback(async () => {
    try {
      const r = await apiRequest("GET", "/api/docs/config");
      const data = await r.json() as { roots?: DocsRoot[] };
      setRoots(data.roots ?? []);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to load config", description: err.message });
    }
  }, [toast]);

  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    try {
      const params = new URLSearchParams();
      if (serverCategory) params.set("category", serverCategory);
      const url = params.toString()
        ? `/api/docs/tree?${params.toString()}`
        : "/api/docs/tree";
      const r = await apiRequest("GET", url);
      const data = await r.json() as { trees?: RootTree[]; roots?: DocsRoot[]; error?: string };
      if (data.error) throw new Error(data.error);
      setRootTrees(data.trees ?? []);
      if (data.roots) setRoots(data.roots);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to scan folder", description: err.message });
      setRootTrees([]);
    } finally {
      setLoadingTree(false);
    }
  }, [toast, serverCategory]);

  const refresh = useCallback(async () => {
    try {
      await apiRequest("POST", "/api/docs/reindex", {});
    } catch (err: any) {
      toast({ variant: "destructive", title: "Reindex failed", description: err.message });
    }
    void loadTree();
  }, [loadTree, toast]);

  const [embedding, setEmbedding] = useState(false);
  const backfillEmbeddings = useCallback(async (overwrite: boolean) => {
    if (embedding) return;
    setEmbedding(true);
    try {
      const r = await apiRequest("POST", "/api/docs/embed-all", { overwrite });
      const data = await r.json() as {
        total: number; docsEmbedded: number; docsSkipped: number;
        docsFailed: number; chunksEmbedded: number; sampleError?: string;
      };
      const parts = [
        `${data.docsEmbedded} embedded (${data.chunksEmbedded} chunks)`,
        `${data.docsSkipped} already done`,
        `${data.docsFailed} failed`,
      ].join(" · ");
      toast({
        variant: data.docsFailed > 0 ? "destructive" : "default",
        title: data.docsFailed > 0 ? "Embedding finished with errors" : "Embedding complete",
        description: data.docsFailed > 0 && data.sampleError
          ? `${parts}\n${data.sampleError}`
          : parts,
      });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Embed failed", description: err.message });
    } finally {
      setEmbedding(false);
    }
  }, [embedding, toast]);

  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => { if (roots.length > 0) void loadTree(); }, [roots.length, loadTree]);

  // popstate fires when the user swipes back (WKWebView edge-swipe) or
  // hits the back button. If the popped state is no longer "viewing a
  // file" — i.e. we've returned to the entry before the first openFile
  // pushState — collapse back to the file list.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      if (!e.state?.docsFile) {
        setSelected(null);
        setSelectedDoc(null);
        setContent("");
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Deep link: /docs?path=foo/bar.md&rootId=...&excerpt=... opens
  // that file once the trees have loaded. rootId optional for
  // back-compat. `excerpt` is consumed by the post-render scroll
  // effect below to jump to the cited passage.
  useEffect(() => {
    if (roots.length === 0 || rootTrees.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get("path");
    const wantedRoot = params.get("rootId") ?? roots[0].id;
    if (wanted && (wanted !== selected?.path || wantedRoot !== selected?.rootId)) {
      void openFile(wantedRoot, wanted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots.length, rootTrees.length]);

  // After the file content renders, look for ?excerpt= in the URL
  // and jump to that passage in the rendered DOM. We can't reliably
  // map source char offsets to DOM positions because markdown
  // syntax (** _ #) doesn't show up in the rendered text — so we
  // search for the excerpt's first chunk instead. Adds a temporary
  // highlight that fades after 4s. URL is cleaned afterward so a
  // reload doesn't re-trigger the jump.
  useEffect(() => {
    if (!content || loadingFile) return;
    const params = new URLSearchParams(window.location.search);
    const excerpt = params.get("excerpt");
    if (!excerpt) return;
    // Match on the first ~60 chars (or the whole thing if short).
    // Markdown rendering can split phrases across nested elements;
    // a short anchor keeps the match resilient to that.
    const needle = excerpt.slice(0, Math.min(60, excerpt.length)).trim();
    if (!needle) return;
    // Wait one frame so the markdown has actually mounted to the DOM.
    const id = requestAnimationFrame(() => {
      const root = document.querySelector(".markdown-body");
      if (!root) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue ?? "";
        if (text.indexOf(needle) >= 0) {
          const parent = node.parentElement;
          if (parent) {
            parent.scrollIntoView({ behavior: "smooth", block: "center" });
            parent.classList.add("docs-cite-highlight");
            setTimeout(() => parent.classList.remove("docs-cite-highlight"), 4000);
          }
          break;
        }
      }
      // Drop excerpt from the URL so reloading doesn't keep
      // re-scrolling — keeps path/rootId.
      params.delete("excerpt");
      const qs = params.toString();
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    });
    return () => cancelAnimationFrame(id);
  }, [content, loadingFile]);

  const saveNewRoot = async () => {
    const path = draftRootPath.trim();
    if (!path) return;
    try {
      const r = await apiRequest("POST", "/api/docs/roots", { path });
      const data = await r.json() as { root?: DocsRoot; error?: string };
      if (data.error) throw new Error(data.error);
      setAddingRoot(false);
      setDraftRootPath("");
      await loadConfig();
      void loadTree();
      toast({ title: "Root added", description: data.root?.path });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Add root failed", description: err.message });
    }
  };

  const deleteRoot = async (root: DocsRoot) => {
    if (!confirm(`Remove "${root.label}" from docs roots? Documents from this folder will be dropped from the index (the files themselves stay on disk).`)) return;
    try {
      await apiRequest("DELETE", `/api/docs/roots/${encodeURIComponent(root.id)}`);
      if (selected?.rootId === root.id) {
        setSelected(null);
        setSelectedDoc(null);
        setContent("");
      }
      await loadConfig();
      void loadTree();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Remove failed", description: err.message });
    }
  };

  const openFile = useCallback(async (rootId: string, filePath: string) => {
    // First-time selection on this page pushes a history entry so the
    // browser back button — and iOS's edge-swipe-to-go-back gesture in
    // the WKWebView wrapper — returns us to the file list without
    // leaving the route. Subsequent file switches don't push again
    // (we only need one "back" step to escape the viewer).
    setSelected(prev => {
      if (!prev) {
        const next = new URL(window.location.href);
        next.searchParams.set("path", filePath);
        next.searchParams.set("rootId", rootId);
        window.history.pushState({ docsFile: true }, "", next);
      }
      return { rootId, path: filePath };
    });
    setLoadingFile(true);
    try {
      const fileQs = new URLSearchParams({ path: filePath, rootId });
      const metaQs = new URLSearchParams({ path: filePath, rootId });
      const [fileRes, metaRes] = await Promise.all([
        apiRequest("GET", `/api/docs/file?${fileQs.toString()}`),
        apiRequest("GET", `/api/docs/by-path?${metaQs.toString()}`),
      ]);
      if (!fileRes.ok) {
        const data = await fileRes.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${fileRes.status}`);
      }
      setContent(await fileRes.text());
      if (metaRes.ok) {
        const m = await metaRes.json() as { document?: DocumentMeta };
        setSelectedDoc(m.document ?? null);
      } else {
        setSelectedDoc(null);
      }
    } catch (err: any) {
      setContent("");
      setSelectedDoc(null);
      toast({ variant: "destructive", title: "Failed to open file", description: err.message });
    } finally {
      setLoadingFile(false);
    }
  }, [toast]);

  const toggleStar = async () => {
    if (!selectedDoc) return;
    const next = selectedDoc.starred ? 0 : 1;
    setSelectedDoc({ ...selectedDoc, starred: next });
    try {
      await apiRequest("PATCH", `/api/docs/${selectedDoc.id}/starred`, { starred: !!next });
      void loadTree();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Star failed", description: err.message });
      setSelectedDoc(selectedDoc);
    }
  };

  const setDocCategory = async (category: "personal" | "work") => {
    if (!selectedDoc || selectedDoc.category === category) return;
    setSelectedDoc({ ...selectedDoc, category });
    try {
      await apiRequest("PATCH", `/api/docs/${selectedDoc.id}/category`, { category });
      void loadTree();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Category change failed", description: err.message });
    }
  };

  const addNoteForSelection = async () => {
    if (!selectedDoc) return;
    const sel = window.getSelection()?.toString().trim() ?? "";
    let docStartChar: number | null = null;
    let docEndChar: number | null = null;
    let excerpt: string | null = null;
    if (sel) {
      const first = content.indexOf(sel);
      const second = first >= 0 ? content.indexOf(sel, first + 1) : -1;
      if (first >= 0 && second === -1) {
        docStartChar = first;
        docEndChar = first + sel.length;
      }
      excerpt = sel.length > 600 ? sel.slice(0, 600) + "…" : sel;
    }
    const title = excerpt
      ? (excerpt.length > 60 ? excerpt.slice(0, 57) + "…" : excerpt)
      : `Note on ${selectedDoc.title}`;
    try {
      const r = await apiRequest("POST", "/api/clips", {
        title,
        note: null,
        anchors: [{ documentId: selectedDoc.id, docStartChar, docEndChar, excerpt }],
      });
      const data = await r.json() as { clip?: { id: string }; error?: string };
      if (data.error) throw new Error(data.error);
      toast({
        title: docStartChar != null ? "Note saved" : "Whole-doc note saved",
        description: excerpt ? `"${excerpt.slice(0, 80)}${excerpt.length > 80 ? "…" : ""}"` : selectedDoc.title,
      });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Save note failed", description: err.message });
    }
  };

  // Flat-list filter mode: search across every root.
  const flatFiles = useMemo(() => {
    const out: { root: DocsRoot; node: TreeNode }[] = [];
    const walk = (root: DocsRoot, nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === "file") out.push({ root, node: n });
        if (n.children) walk(root, n.children);
      }
    };
    for (const rt of rootTrees) walk(rt.root, rt.tree);
    return out;
  }, [rootTrees]);

  const filteredFlat = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return [];
    return flatFiles.filter(({ node }) =>
      node.path.toLowerCase().includes(q) || node.name.toLowerCase().includes(q),
    );
  }, [filter, flatFiles]);

  return (
    <div className="px-4 py-4 space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2">
              <FolderOpen className="h-4 w-4" />
              Docs
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loadingTree || roots.length === 0}>
                <RefreshCw className={cn("h-3.5 w-3.5", loadingTree && "animate-spin")} />
                Refresh
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void backfillEmbeddings(false)}
                disabled={embedding || roots.length === 0}
                title="Embed every doc that isn't already embedded with the current model. Re-embeds happen automatically on file change; this is for the one-time backfill of existing files."
              >
                {embedding
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Sparkles className="h-3.5 w-3.5" />}
                Embed all
              </Button>
            </div>
          </div>

          {/* Roots list — show each configured root with a remove
              button, plus a row to add a new one. */}
          <div className="mt-3 space-y-1.5 text-xs">
            {roots.map((r) => (
              <div key={r.id} className="flex items-center gap-2 rounded border bg-muted/30 px-2 py-1">
                <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="font-medium">{r.label}</span>
                <span className="font-mono text-muted-foreground truncate flex-1" title={r.path}>{r.path}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  onClick={() => deleteRoot(r)}
                  aria-label="Remove root"
                  title="Remove this root from the index"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {addingRoot ? (
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <FolderInput
                    value={draftRootPath}
                    onChange={setDraftRootPath}
                    placeholder="/absolute/path/to/docs/folder"
                    prompt="Choose another markdown docs folder"
                    className="font-mono text-xs"
                  />
                </div>
                <Button size="sm" onClick={saveNewRoot} disabled={!draftRootPath.trim()}>Save</Button>
                <Button size="sm" variant="ghost" onClick={() => { setAddingRoot(false); setDraftRootPath(""); }}>
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setAddingRoot(true)}>
                <FolderPlus className="h-3.5 w-3.5" />
                Add root folder
              </Button>
            )}
          </div>
        </CardHeader>
      </Card>

      {roots.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Point Concord at one or more folders of <code>.md</code> files to browse them here.
            Click "Add root folder" above.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[320px_1fr] min-w-0">
          <Card className={cn(
            "min-w-0 overflow-hidden lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto",
            selected && "hidden lg:block",
          )}>
            <CardContent className="p-2 space-y-2 min-w-0">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter files across all roots"
                  className="pl-7 h-8 text-xs"
                />
              </div>
              {loadingTree ? (
                <div className="flex items-center gap-2 p-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Scanning…
                </div>
              ) : filter.trim() ? (
                <div className="text-xs">
                  {filteredFlat.length === 0
                    ? <div className="px-2 py-1 text-muted-foreground">No matches</div>
                    : filteredFlat.map(({ root, node }) => (
                      <FileRow
                        key={`${root.id}|${node.path}`}
                        node={node}
                        rootId={root.id}
                        rootLabel={roots.length > 1 ? root.label : undefined}
                        selected={selected}
                        onOpen={openFile}
                        showFullPath
                      />
                    ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {rootTrees.map((rt) => (
                    <RootSection
                      key={rt.root.id}
                      root={rt.root}
                      tree={rt.tree}
                      error={rt.error}
                      selected={selected}
                      onOpen={openFile}
                      collapsibleHeader={rootTrees.length > 1}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className={cn(
            "min-w-0 overflow-hidden lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto",
            !selected && "hidden lg:block",
          )}>
            <CardContent className="p-3 lg:p-6 min-w-0">
              {!selected ? (
                <div className="text-sm text-muted-foreground">Pick a file from the tree.</div>
              ) : loadingFile ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="lg:hidden -ml-2 mb-2 h-8 text-xs"
                    onClick={() => window.history.back()}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Files
                  </Button>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    {selectedDoc && (
                      <>
                        <button
                          type="button"
                          aria-label={selectedDoc.starred ? "Unstar" : "Star"}
                          title={selectedDoc.starred ? "Starred" : "Star this doc"}
                          onClick={toggleStar}
                          className={cn(
                            "p-1 rounded hover:bg-secondary transition-colors",
                            selectedDoc.starred ? "text-amber-500" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          <Star className={cn("h-4 w-4", selectedDoc.starred && "fill-current")} />
                        </button>
                        <Select
                          value={selectedDoc.category}
                          onValueChange={(v) => setDocCategory(v as "personal" | "work")}
                        >
                          <SelectTrigger className="h-7 w-[110px] text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="personal">Personal</SelectItem>
                            <SelectItem value="work">Work</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={addNoteForSelection}
                          title="Highlight a passage first to anchor a note to it; otherwise the note anchors to the whole doc"
                        >
                          <NotebookPen className="h-3.5 w-3.5" />
                          Add note
                        </Button>
                        {selectedDoc.author && (
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                            style={selectedDoc.speaker_color
                              ? { background: selectedDoc.speaker_color, color: "white" }
                              : { background: "var(--secondary)" }}
                            title={selectedDoc.speaker_id
                              ? `Attributed to ${selectedDoc.speaker_name} (linked to speaker)`
                              : `Author: ${selectedDoc.author} (no matching speaker — add one on the Speakers page to link)`}
                          >
                            <User className="h-3 w-3" />
                            {selectedDoc.speaker_name ?? selectedDoc.author}
                          </span>
                        )}
                      </>
                    )}
                    <span className="text-xs text-muted-foreground font-mono break-all">
                      {roots.length > 1 && roots.find(r => r.id === selected.rootId)
                        ? `[${roots.find(r => r.id === selected.rootId)!.label}] `
                        : ""}
                      {selected.path}
                    </span>
                  </div>
                  <Markdown source={content} />
                </>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---- Per-root tree section --------------------------------------------

function RootSection({
  root,
  tree,
  error,
  selected,
  onOpen,
  collapsibleHeader,
}: {
  root: DocsRoot;
  tree: TreeNode[];
  error?: string;
  selected: FileSelection | null;
  onOpen: (rootId: string, path: string) => void;
  collapsibleHeader: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      {collapsibleHeader && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          <FolderOpen className="h-3 w-3" />
          <span className="font-medium">{root.label}</span>
        </button>
      )}
      {(!collapsibleHeader || open) && (
        error
          ? <div className="px-2 py-1 text-xs text-destructive">{error}</div>
          : tree.length === 0
            ? <div className="px-2 py-1 text-xs text-muted-foreground">No matching files</div>
            : <TreeList nodes={tree} rootId={root.id} selected={selected} onOpen={onOpen} />
      )}
    </div>
  );
}

function TreeList({
  nodes,
  rootId,
  selected,
  onOpen,
  depth = 0,
}: {
  nodes: TreeNode[];
  rootId: string;
  selected: FileSelection | null;
  onOpen: (rootId: string, path: string) => void;
  depth?: number;
}) {
  return (
    <ul className="text-xs space-y-0.5">
      {nodes.map(node => (
        <TreeNodeRow
          key={node.path}
          node={node}
          rootId={rootId}
          selected={selected}
          onOpen={onOpen}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function TreeNodeRow({
  node,
  rootId,
  selected,
  onOpen,
  depth,
}: {
  node: TreeNode;
  rootId: string;
  selected: FileSelection | null;
  onOpen: (rootId: string, path: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  if (node.type === "file") {
    return <FileRow node={node} rootId={rootId} selected={selected} onOpen={onOpen} depth={depth} />;
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 w-full min-w-0 rounded px-1 py-0.5 hover:bg-secondary text-left"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <FolderOpen className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="font-medium truncate min-w-0">{node.name}</span>
      </button>
      {open && node.children && (
        <TreeList nodes={node.children} rootId={rootId} selected={selected} onOpen={onOpen} depth={depth + 1} />
      )}
    </li>
  );
}

function FileRow({
  node,
  rootId,
  rootLabel,
  selected,
  onOpen,
  depth = 0,
  showFullPath = false,
}: {
  node: TreeNode;
  rootId: string;
  rootLabel?: string;
  selected: FileSelection | null;
  onOpen: (rootId: string, path: string) => void;
  depth?: number;
  showFullPath?: boolean;
}) {
  const active = selected?.rootId === rootId && selected?.path === node.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(rootId, node.path)}
        className={cn(
          "flex items-center gap-1 w-full min-w-0 rounded px-1 py-0.5 text-left hover:bg-secondary",
          active && "bg-secondary text-foreground",
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
        title={node.path}
      >
        <span className="w-3 inline-block shrink-0" />
        <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="truncate flex-1 min-w-0">
          {rootLabel && <span className="text-muted-foreground/70 mr-1">[{rootLabel}]</span>}
          {showFullPath ? node.path : node.name}
        </span>
        {node.starred ? <Star className="h-3 w-3 text-amber-500 fill-current shrink-0" /> : null}
      </button>
    </li>
  );
}
