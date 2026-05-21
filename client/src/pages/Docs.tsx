import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, FileText, FolderOpen, Loader2, RefreshCw, Search, Star } from "lucide-react";
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
  /** Indexer-set fields — present on file nodes after the docs
   *  table has been populated. */
  documentId?: string;
  starred?: number;
  category?: string;
}

interface DocumentMeta {
  id: string;
  rel_path: string;
  title: string;
  starred: number;
  category: string;
}

/**
 * /docs — read-only markdown viewer. Point at a folder of .md files in
 * Settings, browse the tree on the left, read rendered markdown on
 * the right. No DB writes; the tree is recomputed server-side on each
 * GET (cheap for the hundreds-of-files scale).
 */
export default function Docs() {
  const { toast } = useToast();
  const { serverCategory } = useCategory();
  const [rootFolder, setRootFolder] = useState("");
  const [draftFolder, setDraftFolder] = useState("");
  const [editing, setEditing] = useState(false);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<DocumentMeta | null>(null);
  const [content, setContent] = useState<string>("");
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);
  const [filter, setFilter] = useState("");

  const loadConfig = useCallback(async () => {
    try {
      const r = await apiRequest("GET", "/api/docs/config");
      const data = await r.json() as { rootFolder?: string };
      setRootFolder(data.rootFolder ?? "");
      setDraftFolder(data.rootFolder ?? "");
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
      const data = await r.json() as { tree?: TreeNode[]; rootFolder?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setTree(data.tree ?? []);
    } catch (err: any) {
      toast({ variant: "destructive", title: "Failed to scan folder", description: err.message });
      setTree([]);
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

  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => { if (rootFolder) void loadTree(); }, [rootFolder, loadTree]);

  const saveFolder = async () => {
    try {
      const r = await apiRequest("POST", "/api/docs/config", { rootFolder: draftFolder.trim() });
      const data = await r.json() as { rootFolder?: string; error?: string };
      if (data.error) throw new Error(data.error);
      setRootFolder(data.rootFolder ?? "");
      setEditing(false);
      toast({ title: "Folder saved" });
    } catch (err: any) {
      toast({ variant: "destructive", title: "Save failed", description: err.message });
    }
  };

  const openFile = useCallback(async (filePath: string) => {
    setSelectedPath(filePath);
    setLoadingFile(true);
    try {
      // Fetch content + indexed doc metadata in parallel — the
      // header needs the document_id + star/category to render
      // the controls.
      const [fileRes, metaRes] = await Promise.all([
        apiRequest("GET", `/api/docs/file?path=${encodeURIComponent(filePath)}`),
        apiRequest("GET", `/api/docs/by-path?path=${encodeURIComponent(filePath)}`),
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

  // Star + category mutators — optimistic update on the selected doc
  // + the tree node, then refresh tree to pick up filter changes.
  const toggleStar = async () => {
    if (!selectedDoc) return;
    const next = selectedDoc.starred ? 0 : 1;
    setSelectedDoc({ ...selectedDoc, starred: next });
    try {
      await apiRequest("PATCH", `/api/docs/${selectedDoc.id}/starred`, { starred: !!next });
      void loadTree();
    } catch (err: any) {
      toast({ variant: "destructive", title: "Star failed", description: err.message });
      setSelectedDoc(selectedDoc); // revert
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

  // Flatten tree for the filter input — when filter is non-empty,
  // show a flat list of matching files instead of the nested tree.
  const flatFiles = useMemo(() => {
    const out: TreeNode[] = [];
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.type === "file") out.push(n);
        if (n.children) walk(n.children);
      }
    };
    walk(tree);
    return out;
  }, [tree]);

  const filteredFlat = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return [];
    return flatFiles.filter(f =>
      f.path.toLowerCase().includes(q) || f.name.toLowerCase().includes(q),
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
              {!editing && rootFolder && (
                <span className="font-mono text-muted-foreground">{rootFolder}</span>
              )}
              {editing ? (
                <>
                  <div className="w-[420px]">
                    <FolderInput
                      value={draftFolder}
                      onChange={setDraftFolder}
                      placeholder="/absolute/path/to/docs/folder"
                      prompt="Choose your markdown docs folder"
                      className="font-mono text-xs"
                    />
                  </div>
                  <Button size="sm" onClick={saveFolder}>Save</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setDraftFolder(rootFolder); }}>Cancel</Button>
                </>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  {rootFolder ? "Change folder" : "Set folder"}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={loadingTree || !rootFolder}>
                <RefreshCw className={cn("h-3.5 w-3.5", loadingTree && "animate-spin")} />
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      {!rootFolder ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Point Concord at a folder of <code>.md</code> files to browse them here.
            Read-only — nothing is written or indexed yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[320px_1fr]">
          <Card className="lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
            <CardContent className="p-2 space-y-2">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter files"
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
                    : filteredFlat.map(f => (
                      <FileRow key={f.path} node={f} selectedPath={selectedPath} onOpen={openFile} showFullPath />
                    ))}
                </div>
              ) : (
                <TreeList nodes={tree} selectedPath={selectedPath} onOpen={openFile} />
              )}
            </CardContent>
          </Card>

          <Card className="lg:max-h-[calc(100vh-12rem)] lg:overflow-y-auto">
            <CardContent className="p-6">
              {!selectedPath ? (
                <div className="text-sm text-muted-foreground">Pick a file from the tree.</div>
              ) : loadingFile ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              ) : (
                <>
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
                      </>
                    )}
                    <span className="text-xs text-muted-foreground font-mono break-all">{selectedPath}</span>
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

// ---- Tree rendering ----------------------------------------------------

function TreeList({
  nodes,
  selectedPath,
  onOpen,
  depth = 0,
}: {
  nodes: TreeNode[];
  selectedPath: string | null;
  onOpen: (path: string) => void;
  depth?: number;
}) {
  return (
    <ul className="text-xs space-y-0.5">
      {nodes.map(node => (
        <TreeNodeRow
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onOpen={onOpen}
          depth={depth}
        />
      ))}
    </ul>
  );
}

function TreeNodeRow({
  node,
  selectedPath,
  onOpen,
  depth,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onOpen: (path: string) => void;
  depth: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  if (node.type === "file") {
    return <FileRow node={node} selectedPath={selectedPath} onOpen={onOpen} depth={depth} />;
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 w-full rounded px-1 py-0.5 hover:bg-secondary text-left"
        style={{ paddingLeft: depth * 12 + 4 }}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <FolderOpen className="h-3 w-3 text-muted-foreground" />
        <span className="font-medium">{node.name}</span>
      </button>
      {open && node.children && (
        <TreeList nodes={node.children} selectedPath={selectedPath} onOpen={onOpen} depth={depth + 1} />
      )}
    </li>
  );
}

function FileRow({
  node,
  selectedPath,
  onOpen,
  depth = 0,
  showFullPath = false,
}: {
  node: TreeNode;
  selectedPath: string | null;
  onOpen: (path: string) => void;
  depth?: number;
  showFullPath?: boolean;
}) {
  const active = selectedPath === node.path;
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(node.path)}
        className={cn(
          "flex items-center gap-1 w-full rounded px-1 py-0.5 text-left hover:bg-secondary",
          active && "bg-secondary text-foreground",
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
        title={node.path}
      >
        <span className="w-3 inline-block" />
        <FileText className="h-3 w-3 text-muted-foreground" />
        <span className="truncate flex-1">{showFullPath ? node.path : node.name}</span>
        {node.starred ? <Star className="h-3 w-3 text-amber-500 fill-current shrink-0" /> : null}
      </button>
    </li>
  );
}
