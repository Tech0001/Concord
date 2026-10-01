import type { DocumentInfo } from "./types.ts";
export type Folder = {
  name: string;
  path: string;
  folders: Folder[];
  files: DocumentInfo[];
};
export function documentTree(docs: DocumentInfo[]): Folder {
  const root: Folder = { name: "", path: "", folders: [], files: [] };
  for (const doc of docs) {
    const parts = (doc.relative || doc.path?.split("/").at(-1) || doc.title)
      .split("/")
      .filter(Boolean);
    parts.pop();
    let folder = root;
    for (const name of parts) {
      let child = folder.folders.find((f) => f.name === name);
      if (!child) {
        child = {
          name,
          path: `${folder.path}/${name}`,
          folders: [],
          files: [],
        };
        folder.folders.push(child);
      }
      folder = child;
    }
    folder.files.push(doc);
  }
  function sort(folder: Folder) {
    folder.folders.sort((a, b) => a.name.localeCompare(b.name));
    folder.files.sort((a, b) =>
      (a.relative || a.title).localeCompare(b.relative || b.title),
    );
    folder.folders.forEach(sort);
  }
  sort(root);
  return root;
}
export function visibleDocuments(
  docs: DocumentInfo[],
  query: string,
  category: string,
  starred: boolean,
) {
  const q = query.trim().toLowerCase();
  return docs.filter(
    (d) =>
      (!q ||
        `${d.title} ${d.relative || d.path || ""}`.toLowerCase().includes(q)) &&
      (!category || d.category === category) &&
      (!starred || d.starred === 1),
  );
}
