const invoke=(cmd,args)=>window.__TAURI_INTERNALS__.invoke(cmd,args);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const assert=(value,message)=>{if(!value)throw Error(message);};
const until=async(test,message)=>{for(let i=0;i<100;i++){if(await test())return;await sleep(100);}throw Error(`Timed out: ${message}`);};
const passed=[];window.__concordSmokePassed=passed;
const state=await invoke('overview');
assert(state.media===0&&state.notes===0&&state.docs===0&&state.speakers===0,'empty test library');
if(config.id==='restart'){
  assert(state.libraryStarted,'choice persisted across application restart');
  await until(()=>document.body.textContent.includes('No recordings yet'),'normal empty library');
  assert(!document.querySelector('.welcome'),'no repeat welcome');
  passed.push('restarting an empty library keeps the normal Library view');
}else{
  assert(!state.libraryStarted,'each fresh database has its own first-run state');
  await until(()=>document.querySelector('.welcome'),'new-library choice');
  const welcome=document.querySelector('.welcome');
  const primary=welcome.querySelector('.welcome-actions button');
  assert(primary.textContent.trim()==='Start a new library','new library is primary');
  const secondary=welcome.querySelector('.welcome-import button');
  assert(secondary.textContent.includes('Import existing library'),'import remains secondary');
  assert(primary.getBoundingClientRect().top<secondary.getBoundingClientRect().top,'new library appears above import');
  passed.push('fresh library offers Start a new library first, with import underneath');
  if(config.id==='start'){
    primary.click();
    await until(()=>document.body.textContent.includes('No recordings yet'),'normal empty Library after choosing new');
    assert(!document.querySelector('.welcome'),'new library exits welcome');
    assert([...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Add recordings'),'normal import-recordings action');
    const after=await invoke('overview');
    assert(after.libraryStarted&&after.media===0&&after.notes===0&&after.docs===0&&after.speakers===0,'starts empty without copying the archive');
    passed.push('starting a new library opens an empty Library without importing anything');
  }
}
return {passed};
