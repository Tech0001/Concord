import assert from "node:assert/strict";
import test from "node:test";
import { addLabel, addedMessage, followOffer, looksLikeLinks, needsDownloader, shortLink, splitLinks, videoDate } from "./model.ts";

test("pasted text becomes a clean list of links", () => {
  const text = "https://youtu.be/aaa\n  https://www.youtube.com/@TuesdayStudy , https://youtu.be/aaa\nnot a link\nhttp://example.com/x";
  assert.deepEqual(splitLinks(text), ["https://youtu.be/aaa", "https://www.youtube.com/@TuesdayStudy", "http://example.com/x"]);
  assert.equal(looksLikeLinks("see https://youtu.be/aaa"), true);
  assert.equal(looksLikeLinks("just words"), false);
});

test("the Add button says what will happen", () => {
  assert.equal(addLabel({ recordings: 3, videos: 0, follows: [], watching: false }), "Add 3 recordings");
  assert.equal(addLabel({ recordings: 1, videos: 0, follows: [], watching: false }), "Add 1 recording");
  assert.equal(addLabel({ recordings: 23, videos: 0, follows: [], watching: true }), "Add 23 and keep watching");
  assert.equal(addLabel({ recordings: 0, videos: 2, follows: [], watching: false }), "Add 2 videos");
  assert.equal(addLabel({ recordings: 0, videos: 0, follows: ["Tuesday Study"], watching: false }), "Follow Tuesday Study");
  assert.equal(addLabel({ recordings: 0, videos: 0, follows: ["A", "B"], watching: false }), "Follow 2 channels");
  assert.equal(addLabel({ recordings: 2, videos: 1, follows: [], watching: false }), "Add all");
  assert.equal(addLabel({ recordings: 0, videos: 0, follows: [], watching: true }), "Keep watching");
  assert.equal(addLabel({ recordings: 0, videos: 0, follows: [], watching: false }), "Add");
});

const video = (channel: string, channelUrl: string | null) => ({ url: "", id: "x", title: "t", channel, channelUrl, duration: 0, date: "" });

test("after adding videos from one channel, Concord offers to follow it", () => {
  const garden = { video: video("Tuesday Study", "https://www.youtube.com/@TuesdayStudy"), followingChannel: false };
  assert.deepEqual(followOffer([garden, garden]), { name: "Tuesday Study", url: "https://www.youtube.com/@TuesdayStudy" });
  assert.equal(followOffer([{ ...garden, followingChannel: true }]), null);
  assert.equal(followOffer([garden, { video: video("Other", "https://www.youtube.com/@Other"), followingChannel: false }]), null);
  assert.equal(followOffer([{ video: video("Tuesday Study", null), followingChannel: false }]), null);
  assert.equal(followOffer([]), null);
});

test("the confirmation says what was added", () => {
  const none = { recordings: 0, videos: 0, follows: [] as string[], watching: [] as string[] };
  assert.equal(addedMessage({ ...none, recordings: 3 }), "3 recordings added");
  assert.equal(addedMessage({ ...none, recordings: 1, videos: 2 }), "1 recording and 2 videos added");
  assert.equal(addedMessage({ ...none, follows: ["Tuesday Study"] }), "Following Tuesday Study");
  assert.equal(addedMessage({ ...none, recordings: 23, watching: ["Interviews"] }), "23 recordings added · watching Interviews");
  assert.equal(addedMessage({ ...none, videos: 1, follows: ["A", "B"] }), "1 video added · following 2 channels");
  assert.equal(addedMessage({ ...none, watching: ["Interviews"] }), "Watching Interviews");
  assert.equal(addedMessage(none), "Already in your library");
});

test("only links Concord can download need the download tool", () => {
  assert.equal(needsDownloader(["https://www.youtube.com/@TuesdayStudy", "https://example.com/notes"]), true);
  assert.equal(needsDownloader(["https://youtu.be/abc"]), true);
  assert.equal(needsDownloader(["http://m.youtube.com/watch?v=abc"]), true);
  assert.equal(needsDownloader(["https://example.com/notes"]), false);
  assert.equal(needsDownloader(["https://notyoutube.com/watch?v=abc", "not a url"]), false);
});

test("video dates and links read naturally", () => {
  assert.equal(videoDate("20260914"), "September 14, 2026");
  assert.equal(videoDate(""), "");
  assert.equal(videoDate("soon"), "");
  assert.equal(shortLink("https://www.example.com/notes/today?x=1"), "example.com/notes/today");
  assert.equal(shortLink("not a url"), "not a url");
});
