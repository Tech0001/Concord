import assert from "node:assert/strict";
import test from "node:test";
import { checkedAgo, followingMeta, followingNote, isFollowed } from "./following.ts";
import type { Source } from "../pipeline/types.ts";

const NOW = Date.UTC(2026, 9, 7, 15, 0, 0) / 1000;
const source = (o: Partial<Source> = {}): Source => ({
  id: "s1", name: "Tuesday Study", url: "https://www.youtube.com/@TuesdayStudy", kind: "youtube", enabled: 1, diarize: 1, include_shorts: 0,
  category: "personal", last_check: NOW - 2 * 3600, check_status: "complete", check_message: "", recordings: 4, since: NOW - 86400, ...o,
});

test("only sources followed for new recordings show under Following", () => {
  assert.equal(isFollowed(source()), true);
  assert.equal(isFollowed(source({ since: 0 })), false);
  assert.equal(isFollowed(source({ enabled: 0 })), false);
  assert.equal(isFollowed(source({ kind: "collection" })), false);
});

test("the last check reads as a rough time ago", () => {
  assert.equal(checkedAgo(0, NOW), "not checked yet");
  assert.equal(checkedAgo(NOW - 20, NOW), "checked just now");
  assert.equal(checkedAgo(NOW - 60, NOW), "checked 1 minute ago");
  assert.equal(checkedAgo(NOW - 5 * 60, NOW), "checked 5 minutes ago");
  assert.equal(checkedAgo(NOW - 2 * 3600, NOW), "checked 2 hours ago");
  assert.equal(checkedAgo(NOW - 3 * 86400, NOW), "checked 3 days ago");
});

test("a followed source's header says what it is and how it is set up", () => {
  assert.equal(followingMeta(source(), NOW), "Channel · Personal · speakers identified · checked 2 hours ago");
  assert.equal(followingMeta(source({ url: "https://www.youtube.com/playlist?list=PL1", diarize: 0 }), NOW), "Playlist · Personal · checked 2 hours ago");
  assert.equal(followingMeta(source({ kind: "folder", url: "/home/you/Interviews", category: "work", check_status: "checking" }), NOW), "Folder · Work · speakers identified · checking now");
  assert.equal(followingMeta(source({ check_status: "failed", check_message: "The channel is unavailable" }), NOW), "Channel · Personal · speakers identified · last check failed: The channel is unavailable");
  assert.equal(followingMeta(source({ check_status: "queued" }), NOW), "Channel · Personal · speakers identified · waiting to check");
  assert.equal(followingMeta(source({ check_status: "cancelled", check_message: "Source check stopped" }), NOW), "Channel · Personal · speakers identified · check stopped");
  assert.equal(followingNote(source(), NOW), "New videos are added while Concord is open. Following since October 6.");
  assert.equal(followingNote(source({ kind: "folder" }), NOW), "Recordings saved in this folder are added while Concord is open. Watching since October 6.");
  assert.equal(followingNote(source({ since: Date.UTC(2025, 2, 3, 12) / 1000 }), NOW), "New videos are added while Concord is open. Following since March 3, 2025.");
});
