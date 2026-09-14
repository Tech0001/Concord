import assert from "node:assert/strict";
import test from "node:test";
import { loadCompareSources, saveCompareSources, type CompareSource } from "./compare-sources";

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

test("comparison workspace persists at most two typed sources", () => {
  const storage = new MemoryStorage();
  const sources: CompareSource[] = [
    { kind: "video", videoId: "v1", channelId: "c1", title: "Video" },
    { kind: "doc", documentId: "d1", rootId: "r1", relPath: "one.md", title: "Document" },
    { kind: "note", noteId: "n1", title: "Note" },
  ];
  saveCompareSources(sources, storage);
  assert.deepEqual(loadCompareSources(storage), sources.slice(0, 2));
});

test("malformed comparison state degrades to an empty workspace", () => {
  const storage = new MemoryStorage();
  storage.setItem("concord-compare-sources-v1", "broken json");
  assert.deepEqual(loadCompareSources(storage), []);
});
