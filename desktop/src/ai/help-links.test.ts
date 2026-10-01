import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_LINKS } from "./help-links.ts";
import { formatRoute, parseRoute } from "../lib/router.ts";
test("help links navigate to known screens without action payloads",()=>{
  for(const [href,route] of Object.entries(HELP_LINKS)) {
    if(route!=="health") assert.deepEqual(parseRoute(href),route);
  }
  for(const url of ['javascript:alert(1)','file:///home/pc','concord:delete','#/pipeline?tab=queue&action=start','#/settings?section=ai&key=secret'])assert.ok(!Object.hasOwn(HELP_LINKS,url));
});
test("help intent routes retain the explicit context and question",()=>{
  const route={page:'ai',context:'help',question:'Why is my folder not scanning?'} as const;
  assert.deepEqual(parseRoute(formatRoute(route)),route);
  assert.deepEqual(parseRoute('#/ai?context=autodetect'),{page:'ai'});
});
