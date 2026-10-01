import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoute, formatRoute, type Route } from "./router.ts";

test("recording ids with JSON, slashes, ? and # round-trip", () => {
  const route: Route = { page: "recording", id: '["UC-x","a/b?c#d"]', at: 12.5 };
  const hash = formatRoute(route);
  assert.ok(!hash.slice(2).includes("#"));
  assert.deepEqual(parseRoute(hash), route);
});

test("search keeps its query; documents keep their id", () => {
  assert.deepEqual(parseRoute(formatRoute({ page: "search", q: "harbour lights & more" })), { page: "search", q: "harbour lights & more" });
  assert.deepEqual(parseRoute("#/documents/doc%3A1"), { page: "documents", id: "doc:1" });
  assert.equal(formatRoute({ page: "documents" }), "#/documents");
});

test("unknown, empty and malformed routes fall back to the library", () => {
  assert.deepEqual(parseRoute(""), { page: "library" });
  assert.deepEqual(parseRoute("#/nope"), { page: "library" });
  assert.deepEqual(parseRoute("#/recording/"), { page: "library" });
  assert.deepEqual(parseRoute("#/recording/abc?t=-3"), { page: "recording", id: "abc" });
  assert.deepEqual(parseRoute("#/recording/abc?t=x"), { page: "recording", id: "abc" });
  assert.deepEqual(parseRoute("#/speakers"), { page: "speakers" });
});

test("setup keeps its step, where to return, and a preselected chat provider", () => {
  const route: Route = { page: "setup", step: "ai", returnTo: "ai", chat: "openrouter" };
  assert.equal(formatRoute(route), "#/setup?step=ai&return=ai&chat=openrouter");
  assert.deepEqual(parseRoute(formatRoute(route)), route);
  for (const chat of ["codex", "claude-code"] as const) {
    const subscription: Route = { ...route, chat };
    assert.deepEqual(parseRoute(formatRoute(subscription)), subscription);
  }
  assert.deepEqual(parseRoute("#/setup"), { page: "setup" });
  assert.deepEqual(parseRoute("#/setup?step=nowhere&return=recording&chat=fax"), { page: "setup" });
});

test("settings sections and pipeline tabs can be linked to", () => {
  assert.deepEqual(parseRoute(formatRoute({ page: "settings", section: "speech" })), { page: "settings", section: "speech" });
  assert.deepEqual(parseRoute("#/settings?section=elsewhere"), { page: "settings" });
  assert.equal(formatRoute({ page: "settings" }), "#/settings");
  assert.deepEqual(parseRoute(formatRoute({ page: "pipeline", tab: "sources" })), { page: "pipeline", tab: "sources" });
  assert.deepEqual(parseRoute("#/pipeline"), { page: "pipeline" });
});
