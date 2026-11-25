import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFilter, readViews, viewKey, DEFAULT_FILTER } from "./model.ts";
import { inCategory } from "../notes/model.ts";
test("saved views accept earlier filters and discard corrupt storage", () => {
  assert.deepEqual(normalizeFilter(null), DEFAULT_FILTER);
  const bad = normalizeFilter({ category: "secret", status: "anything", kind: "photo", offset: -2, limit: 7, sort: "sql", starred: "false" });
  assert.deepEqual(bad, DEFAULT_FILTER);
  const views=readViews([null,{id:"old",name:" Meetings ",filter:{channel:"Meetings",sort:"oldest",offset:120}},{id:"old",name:"duplicate"},{name:"no id"}]);
  assert.equal(views.length,1);assert.equal(views[0].name,"Meetings");assert.equal(views[0].filter.channel,"Meetings");assert.equal(views[0].filter.offset,0);
  assert.equal(viewKey({...DEFAULT_FILTER,offset:120},"list"),viewKey(DEFAULT_FILTER,"list"));
  assert.notEqual(viewKey({...DEFAULT_FILTER,category:"work"},"grid"),viewKey(DEFAULT_FILTER,"grid"));
});
test("notes follow their evidence categories and standalone notes stay visible",()=>{
  const note={title:"Mixed sources",body:"",anchors:[{media_id:"one",category:"work" as const,quote:""},{doc_id:"two",category:"personal" as const,quote:""}]};
  assert.ok(inCategory(note,"work"));assert.ok(inCategory(note,"personal"));
  assert.equal(inCategory({...note,anchors:note.anchors.slice(0,1)},"personal"),false);
  assert.ok(inCategory({...note,anchors:[]},"work"));
});

import { jobProgress } from "./model.ts";
import type { Media } from "../lib/types.ts";
const media = (patch: Partial<Media>): Media => ({ id: "m", title: "t", channel: "c", date: "", duration: 0, path: "/a.m4a", transcript: null, words: 0, status: "ready", kind: "audio", starred: 0, review_state: "unreviewed", position: 0, opened_at: null, ...patch });

test("each recording says how far along it is", () => {
  assert.deepEqual(jobProgress(media({ processing_status: "processing", job_kind: "download", path: null, job_message: "45.2% · 3MiB/s · 00:20 remaining" })), { label: "Downloading · 45%", tone: "busy", pct: 45 });
  assert.deepEqual(jobProgress(media({ processing_status: "processing", job_kind: "transcribe", job_message: "Transcribing and identifying speakers" })), { label: "Transcribing", tone: "busy", pct: null });
  assert.deepEqual(jobProgress(media({ processing_status: "pending", job_kind: "download", path: null, job_message: "Waiting in the processing queue" })), { label: "Waiting to download", tone: "wait", pct: null });
  assert.deepEqual(jobProgress(media({ processing_status: "pending", job_kind: "transcribe", job_message: "Waiting in the processing queue" })), { label: "Waiting to transcribe", tone: "wait", pct: null });
  assert.deepEqual(jobProgress(media({ processing_status: "pending", job_message: "Waiting for the speech engine to finish installing" })), { label: "Waiting for the speech engine", tone: "wait", pct: null });
  assert.deepEqual(jobProgress(media({ processing_status: "failed", job_message: "This file can't be read." })), { label: "Needs attention", tone: "bad", pct: null });
  assert.equal(jobProgress(media({ processing_status: "complete", transcript: "t.md" })), null);
  assert.equal(jobProgress(media({ processing_status: "ready" })), null);
});
