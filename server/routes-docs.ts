import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import {
  addRoot,
  findRootById,
  getDocument,
  getDocumentByRelPath,
  indexDocs,
  listDocuments,
  listRoots,
  removeRoot,
  renameRoot,
  setDocumentCategory,
  setDocumentStarred,
  setRoots,
  type DocsRoot,
  type DocumentRow,
} from "./docs-index";
import { embedDocument } from "./docs-embed";

/**
 * Markdown file viewer + roots-management endpoints. Multi-root:
 * /api/docs/config returns the array of configured roots;
 * /api/docs/tree returns one tree per root; /api/docs/file +
 * /api/docs/by-path require a root id to disambiguate when a rel_path
 * exists in more than one root.
 *
 * Path safety: every file read resolves against the root's path and
 * rejects anything outside it.
 */
export function registerDocsRoutes(app: Express): void {
  app.get("/api/docs/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const roots = listRoots();
    res.json({
      roots,
      // Back-compat alias for older clients that read rootFolder.
      rootFolder: roots[0]?.path || "",
    });
  });

  // Add a new root. Auto-detects whether to use the legacy empty id
  // (first root) or a new opaque id (subsequent). Re-indexes
  // immediately so the tree request right after this returns
  // populated data.
  app.post("/api/docs/roots", (req, res) => {
    const inputPath = typeof req.body?.path === "string" ? req.body.path : "";
    const label = typeof req.body?.label === "string" ? req.body.label : undefined;
    if (!inputPath.trim()) {
      return res.status(400).json({ error: "path is required" });
    }
    try {
      const root = addRoot({ path: inputPath, label });
      const index = indexDocs();
      res.json({ root, index });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to add root" });
    }
  });

  app.delete("/api/docs/roots/:id", (req: Request<{ id: string }>, res) => {
    const ok = removeRoot(req.params.id);
    if (!ok) return res.status(404).json({ error: "Root not found" });
    res.json({ ok: true });
  });

  app.patch("/api/docs/roots/:id", (req: Request<{ id: string }>, res) => {
    const label = typeof req.body?.label === "string" ? req.body.label : "";
    if (!label.trim()) return res.status(400).json({ error: "label is required" });
    const root = renameRoot(req.params.id, label);
    if (!root) return res.status(404).json({ error: "Root not found" });
    res.json({ root });
  });

  // Back-compat: old single-folder config endpoint. POST replaces
  // root[0] OR adds the first root if none exist. New code should
  // use POST /api/docs/roots instead.
  app.post("/api/docs/config", (req, res) => {
    const rootFolder = typeof req.body?.rootFolder === "string"
      ? req.body.rootFolder.trim()
      : "";
    if (!rootFolder) {
      // Clear all roots.
      for (const r of listRoots()) removeRoot(r.id);
      res.json({ ok: true, rootFolder: "" });
      return;
    }
    if (!fs.existsSync(rootFolder)) {
      return res.status(400).json({ error: `Folder does not exist: ${rootFolder}` });
    }
    try {
      const existing = listRoots();
      if (existing.length === 0) {
        addRoot({ path: rootFolder });
      } else {
        // Replace the first root's path, preserving its id so existing
        // doc ids don't churn.
        const updated: DocsRoot[] = [{ ...existing[0], path: rootFolder, label: path.basename(rootFolder) || rootFolder }, ...existing.slice(1)];
        setRoots(updated);
      }
      const index = indexDocs();
      res.json({ ok: true, rootFolder, index });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Failed to set root" });
    }
  });

  app.post("/api/docs/reindex", (_req, res) => {
    try {
      res.json({ index: indexDocs() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "reindex failed" });
    }
  });

  // Tree: one entry per configured root, each with its own nested
  // folder structure. Filters (category / starred) apply per root
  // and a root with zero matches is still returned (empty children
  // list) so the user can see it exists in the sidebar.
  app.get("/api/docs/tree", (req, res) => {
    const roots = listRoots();
    const catParam = String(req.query.category || "both");
    const starredOnly = String(req.query.starred || "all") === "yes";
    try {
      const allDocs = listDocuments();
      const trees = roots.map((root) => {
        if (!fs.existsSync(root.path)) {
          return { root, tree: [] as DocsTreeNode[], error: "folder missing" };
        }
        const rootDocs = allDocs.filter((d) => (d.root_id ?? "") === root.id);
        const docsByPath = new Map(rootDocs.map((d) => [d.rel_path, d]));
        let tree = buildTree(root.path, "", docsByPath);
        if (catParam === "personal" || catParam === "work") {
          tree = filterTreeByCategory(tree, catParam);
        }
        if (starredOnly) tree = filterTreeByStarred(tree);
        return { root, tree };
      });
      res.json({
        roots,
        trees,
        // Back-compat scalar fields for clients that haven't switched
        // to the trees[] shape yet.
        rootFolder: roots[0]?.path || "",
        tree: trees[0]?.tree || [],
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to scan docs folder" });
    }
  });

  // Single doc metadata — used by the viewer header. Accepts either
  // (rootId, path) for the multi-root form or just path for legacy
  // single-root clients.
  app.get("/api/docs/by-path", (req, res) => {
    const rel = String(req.query.path || "");
    if (!rel) return res.status(400).json({ error: "path is required" });
    const rootId = typeof req.query.rootId === "string" ? req.query.rootId : undefined;
    const doc = getDocumentByRelPath(rel, rootId);
    if (!doc) return res.status(404).json({ error: "Document not in index — try Refresh" });
    res.json({ document: doc });
  });

  app.patch("/api/docs/:id/starred", (req: Request<{ id: string }>, res) => {
    const doc = getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    setDocumentStarred(req.params.id, !!req.body?.starred);
    res.json({ ok: true });
  });

  app.patch("/api/docs/:id/category", (req: Request<{ id: string }>, res) => {
    const cat = req.body?.category;
    if (cat !== "personal" && cat !== "work") {
      return res.status(400).json({ error: "category must be 'personal' or 'work'" });
    }
    const doc = getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    setDocumentCategory(req.params.id, cat);
    res.json({ ok: true });
  });

  app.post("/api/docs/embed-all", async (req, res) => {
    const skipIfPresent = req.body?.overwrite ? false : true;
    const all = listDocuments();
    const results: { id: string; embedded: number; chunks: number; skipped: number; error?: string }[] = [];
    let totalEmbedded = 0;
    let totalSkipped = 0;
    let failed = 0;
    for (const d of all) {
      try {
        const r = await embedDocument(d.id, { skipIfPresent });
        results.push({ id: r.documentId, embedded: r.embedded, chunks: r.chunks, skipped: r.skipped, error: r.error });
        totalEmbedded += r.embedded;
        totalSkipped += r.skipped;
        if (r.error) failed += 1;
      } catch (err) {
        failed += 1;
        results.push({ id: d.id, embedded: 0, chunks: 0, skipped: 0, error: err instanceof Error ? err.message : "embed failed" });
      }
    }
    res.json({ total: all.length, embedded: totalEmbedded, skipped: totalSkipped, failed, results });
  });

  app.post("/api/docs/:id/embed", async (req: Request<{ id: string }>, res) => {
    const doc = getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });
    const overwrite = req.body?.overwrite === true;
    try {
      const r = await embedDocument(req.params.id, { skipIfPresent: !overwrite });
      res.json(r);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "embed failed" });
    }
  });

  // File read — needs a root to disambiguate when a rel_path exists
  // in more than one root. Falls back to the first root for legacy
  // single-root callers that omit rootId.
  app.get("/api/docs/file", (req: Request, res: Response) => {
    const rel = String(req.query.path ?? "");
    if (!rel) return res.status(400).json({ error: "path is required" });
    const rootId = typeof req.query.rootId === "string" ? req.query.rootId : undefined;
    const roots = listRoots();
    if (roots.length === 0) return res.status(400).json({ error: "Docs folder not configured" });
    const root = rootId !== undefined ? findRootById(rootId) : roots[0];
    if (!root) return res.status(404).json({ error: "Unknown root" });

    const resolved = path.resolve(root.path, rel);
    const rootResolved = path.resolve(root.path);
    // Path-escape protection — `..` segments mustn't let the user
    // pull arbitrary files. Compare resolved paths after canonical.
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      return res.status(403).json({ error: "Path escapes the docs folder" });
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File not found" });

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });
    if (stat.size > 5 * 1024 * 1024) {
      return res.status(413).json({ error: "File too large (>5 MB) to render in the viewer" });
    }

    try {
      const content = fs.readFileSync(resolved, "utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.send(content);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to read file" });
    }
  });
}

export interface DocsTreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: DocsTreeNode[];
  mtimeMs?: number;
  documentId?: string;
  starred?: number;
  category?: string;
}

/** Recursive directory walk. Only includes .md files (and the folders
 *  that contain them, transitively) so the tree stays focused on
 *  what's actually viewable. Skips dotfiles and node_modules. Enriches
 *  each file node with star/category from the documents table. */
function buildTree(
  absRoot: string,
  relPath: string,
  docsByPath: Map<string, DocumentRow>,
): DocsTreeNode[] {
  const abs = path.join(absRoot, relPath);
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const result: DocsTreeNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const childRel = path.posix.join(relPath, entry.name);

    if (entry.isDirectory()) {
      const children = buildTree(absRoot, childRel, docsByPath);
      if (children.length > 0) {
        result.push({ name: entry.name, path: childRel, type: "dir", children });
      }
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      let mtimeMs: number | undefined;
      try { mtimeMs = fs.statSync(path.join(absRoot, childRel)).mtimeMs; } catch { /* ignore */ }
      const doc = docsByPath.get(childRel);
      result.push({
        name: entry.name,
        path: childRel,
        type: "file",
        mtimeMs,
        documentId: doc?.id,
        starred: doc?.starred ?? 0,
        category: doc?.category ?? "personal",
      });
    }
  }

  // Folders first, then files, both alphabetical — matches how most
  // file browsers render and keeps deep planning hierarchies legible.
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  return result;
}

function filterTreeByCategory(nodes: DocsTreeNode[], category: string): DocsTreeNode[] {
  const out: DocsTreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "file") {
      if ((n.category ?? "personal") === category) out.push(n);
    } else if (n.children) {
      const kids = filterTreeByCategory(n.children, category);
      if (kids.length) out.push({ ...n, children: kids });
    }
  }
  return out;
}

function filterTreeByStarred(nodes: DocsTreeNode[]): DocsTreeNode[] {
  const out: DocsTreeNode[] = [];
  for (const n of nodes) {
    if (n.type === "file") {
      if (n.starred) out.push(n);
    } else if (n.children) {
      const kids = filterTreeByStarred(n.children);
      if (kids.length) out.push({ ...n, children: kids });
    }
  }
  return out;
}
