import test from "node:test";
import assert from "node:assert/strict";
import { documentTree, visibleDocuments } from "./tree.ts";
test("folder tree retains nested paths and duplicate names across directories", () => {
  const docs = [
    {
      id: "a",
      title: "One",
      length: 1,
      relative: "b/note.md",
      category: "personal",
      starred: 1,
    },
    {
      id: "b",
      title: "Two",
      length: 1,
      relative: "a/deep/note.md",
      category: "work",
    },
    { id: "c", title: "Loose", length: 1 },
  ];
  const tree = documentTree(docs);
  assert.deepEqual(
    tree.folders.map((f) => f.name),
    ["a", "b"],
  );
  assert.equal(tree.folders[0].folders[0].files[0].id, "b");
  assert.equal(tree.files[0].id, "c");
  assert.deepEqual(
    visibleDocuments(docs, "note.md", "personal", true).map((d) => d.id),
    ["a"],
  );
  assert.equal(visibleDocuments(docs, "deep", "", false).length, 1);
});
