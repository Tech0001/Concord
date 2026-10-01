import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendHits,
  phrases,
  relevance,
  type YouTubeHit,
} from "./discover-model.ts";
const hit = (id: string, title: string, description = ""): YouTubeHit => ({
  videoId: id,
  title,
  description,
  channelId: "",
  channelName: "",
  publishedAt: "",
  live: false,
});
test("Discover phrase hints use titles and descriptions; exclusions win", () => {
  const include = phrases("Prayer,  Study\nMusic");
  assert.deepEqual(include, ["prayer", "study", "music"]);
  assert.equal(
    relevance(hit("a", "A meeting", "PRAYER study"), include, []),
    "include",
  );
  assert.equal(
    relevance(hit("a", "Prayer reaction"), include, ["reaction"]),
    "exclude",
  );
  assert.equal(relevance(hit("a", "Other"), include, []), "neutral");
});
test("Discover pagination preserves earlier items and removes repeated videos", () => {
  assert.deepEqual(
    appendHits(
      [hit("a", "Original")],
      [hit("a", "Duplicate"), hit("b", "Next"), hit("b", "Repeated")],
    ).map((h) => h.title),
    ["Original", "Next"],
  );
});
