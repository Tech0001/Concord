import { test } from "node:test";
import assert from "node:assert/strict";
import { mapItems,endpoint,readHandle,handleKey,filterNotes,graphLinks,viewKey,arcSort,recordingKey,noteKey } from "./model.ts";
import type { Note } from "../lib/types.ts";
const notes:Note[]=[
 {id:"multi",title:"Across sources",body:"Research",tags:["faith","history"],anchors:[{id:"a1",media_id:'["c","v1"]',start:2,end:4,quote:"First",channel:"Meetings",date:"2025-01-02"},{id:"a2",media_id:'["c","v1"]',start:7,end:9,quote:"Later",channel:"Meetings"},{id:"a3",media_id:'["c","v2"]',start:1,end:3,quote:"Another recording"},{id:"a4",doc_id:"doc",quote:"Document"}]},
 {id:"doc-note",title:"Document insight",body:"",tags:["faith"],anchors:[{id:"doc-anchor",doc_id:"doc",quote:"Evidence"}]},
 {id:"free",title:"Standalone",body:"Another thought",tags:[],anchors:[]},
];
test("video containers retain every anchored occurrence, plus document and standalone notes",()=>{
 const items=mapItems(notes,"videos");assert.equal(items.length,4);assert.equal(items.find(i=>i.recording==='["c","v1"]')!.entries.length,2);assert.equal(items.find(i=>i.recording==='["c","v2"]')!.entries[0].anchor!.id,"a3");assert(items.some(i=>i.id===noteKey("doc-note")));assert(items.some(i=>i.id===noteKey("free")));
});
test("connections stay attached to the selected anchor across layouts",()=>{
 const videos=endpoint(notes[0],"a3","bottom","videos");assert.equal(videos.node,recordingKey('["c","v2"]'));assert.deepEqual(readHandle(videos.handle),{note:"multi",anchor:"a3",side:"bottom"});
 const cards=endpoint(notes[0],"a3","left","cards");assert.equal(cards.node,noteKey("multi"));assert.equal(readHandle(cards.handle)!.anchor,"a3");
 assert.deepEqual(readHandle(handleKey('id:" unusual','#anchor/1',"top")),{note:'id:" unusual',anchor:'#anchor/1',side:"top"});assert.equal(readHandle("broken"),undefined);
});
test("filters, computed edges and per-view positions do not mix layouts or source identities",()=>{
 const f={query:"research",collection:"Meetings",tags:["faith","history"],limit:150};assert.equal(filterNotes(notes,f).length,1);
 const links=graphLinks(notes,[{source:"multi",target:"free",kind:"contradicts"}], ["manual","shared_tag"]);assert.equal(links.length,2);assert.equal(links.filter(l=>l.kind==="shared_tag")[0].target,"doc-note");assert.equal(links.filter(l=>l.kind==="manual")[0].link!.kind,"contradicts");
 assert.equal(viewKey("cards",f,"tag"),viewKey("cards",{...f,tags:["history","faith"]},"title"));assert.notEqual(viewKey("cards",f,"tag"),viewKey("videos",f,"tag"));assert.equal(arcSort(notes,"connections",links)[0].id,"multi");
});
