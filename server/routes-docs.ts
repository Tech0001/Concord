import type { Express, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { getConfigValues, setConfigValues } from "./db";
import {
  getDocument,
  getDocumentByRelPath,
  indexDocs,
  listDocuments,
  setDocumentCategory,
  setDocumentStarred,
  type DocumentRow,
} from "./docs-index";

/**
 * Markdown file viewer endpoints — list + read .md files under a user-
 * configured root folder. Read-only; no DB writes, no embedding. The
 * fuller "docs as a content source" plan (embedding, AI-chat
 * integration) layers on top of this once the basic browse loop is in.
 *
 * Path safety: every file/tree request resolves the requested path
 * against the configured root and rejects anything outside it — keeps a
 * malicious or buggy client from reading the rest of the filesystem.
 */
export function registerDocsRoutes(app: Express): void {
  app.get("/api/docs/config", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ rootFolder: getConfigValues()["docs.rootFolder"] || "" });
  });

  app.post("/api/docs/config", (req, res) => {
    const rootFolder = typeof req.body?.rootFolder === "string"
      ? req.body.rootFolder.trim()
      : "";
    if (rootFolder && !fs.existsSync(rootFolder)) {
      return res.status(400).json({ error: `Folder does not exist: ${rootFolder}` });
    }
    setConfigValues({ "docs.rootFolder": rootFolder });
    // Re-index immediately when the folder changes so the UI's first
    // tree request returns rich (star/category-aware) nodes instead of
    // a bare filesystem listing.
    const index = rootFolder ? indexDocs() : null;
    res.json({ ok: true, rootFolder, index });
  });

  // Manual refresh (Docs page "Refresh" button) and the post-edit
  // re-sync entry point. Cheap — sha256 + stat per file.
  app.post("/api/docs/reindex", (_req, res) => {
    try {
      res.json({ index: indexDocs() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "reindex failed" });
    }
  });

  app.get("/api/docs/tree", (req, res) => {
    const root = getConfigValues()["docs.rootFolder"];
    if (!root) return res.json({ tree: [], rootFolder: "" });
    if (!fs.existsSync(root)) return res.status(400).json({ error: `Root folder missing: ${root}` });
    const catParam = String(req.query.category || "both");
    const starredOnly = String(req.query.starred || "all") === "yes";
    try {
      // Index lookup keyed by rel_path so each file node can carry
      // its current id/star/category without an extra round-trip.
      const docsByPath = new Map(listDocuments().map((d) => [d.rel_path, d]));
      let tree = buildTree(root, "", docsByPath);
      if (catParam === "personal" || catParam === "work") {
        tree = filterTreeByCategory(tree, catParam);
      }
      if (starredOnly) tree = filterTreeByStarred(tree);
      res.json({ rootFolder: root, tree });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Failed to scan docs folder" });
    }
  });

  // Single doc metadata — used by the viewer header to show + edit
  // star / category without round-tripping the entire tree.
  app.get("/api/docs/by-path", (req, res) => {
    const rel = String(req.query.path || "");
    if (!rel) return res.status(400).json({ error: "path is required" });
    const doc = getDocumentByRelPath(rel);
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

  app.get("/api/docs/file", (req: Request, res: Response) => {
    const root = getConfigValues()["docs.rootFolder"];
    if (!root) return res.status(400).json({ error: "Docs folder not configured" });
    const rel = String(req.query.path ?? "");
    if (!rel) return res.status(400).json({ error: "path is required" });

    const resolved = path.resolve(root, rel);
    // Escape protection — `..` segments mustn't let the user pull
    // arbitrary files. Compare resolved paths after canonicalization.
    const rootResolved = path.resolve(root);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
      return res.status(403).json({ error: "Path escapes the docs folder" });
    }
    if (!fs.existsSync(resolved)) return res.status(404).json({ error: "File not found" });

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return res.status(400).json({ error: "Not a file" });
    // Soft cap on file size — keep the UI snappy and prevent the
    // browser from choking on a 50 MB doc the user accidentally
    // dropped into the folder.
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
  /** Document index id — present for files that have been ingested
   *  into the documents table. Lets the UI star/categorize/anchor
   *  notes without an extra round-trip. */
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

/** Prune a tree to only the files in the given category, plus their
 *  ancestor folders. A folder with zero matching descendants is
 *  dropped so the user doesn't see empty sections. */
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
