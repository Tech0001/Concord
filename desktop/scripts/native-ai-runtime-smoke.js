// Run with a scratch CONCORD_NEXT_DATA containing the embedding model and a tiny document.
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const until = async (check, label) => {
  for (let i = 0; i < 600; i++) { if (await check()) return; await sleep(100); }
  throw Error(`Timed out: ${label}`);
};
const passed = []; window.__concordSmokePassed = passed;
await until(() => document.querySelector('.setup'), 'fresh setup');
await invoke('start_library'); await invoke('setup_save', { patch: { completed: true } });
for (const kind of ['codex', 'claude-code']) {
  location.hash = `#/setup?step=ai&return=ai&chat=${kind}`;
  await until(() => document.querySelector('[aria-label="Subscription chat model"]'), `${kind} connection screen`);
  await until(() => document.querySelector('.setup-connect')?.textContent.includes(kind === 'codex' ? 'codex login' : 'claude auth login'), `${kind} selected by route`);
  assert(document.querySelector('[aria-label="Subscription chat model"]').value === 'default', 'Default CLI model');
  assert(!document.querySelector('#chat-key'), 'No subscription API-key field');
  passed.push(`${kind} setup deep-link selects the correct CLI without requesting an API key`);
  location.hash = '#/library'; await until(() => !document.querySelector('.setup'), 'exit setup');
}
location.hash = '#/settings?section=ai';
await until(() => document.querySelector('[aria-label="chat provider"]'), 'AI settings');
const choose = async (label) => {
  const trigger = document.querySelector('[aria-label="chat provider"]');
  trigger.scrollIntoView({block:'center'}); await sleep(100);
  trigger.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,pointerType:'mouse',button:0,pointerId:1}));
  await until(() => document.querySelector('[role="listbox"]'), 'provider choices');
  const item = [...document.querySelectorAll('[role="option"]')].find(e=>e.textContent.trim()===label);
  assert(item,'CLI provider option'); item.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await until(()=>!document.querySelector('[role="listbox"]'),'provider chosen');
};
for (const [kind,label] of [['codex','Codex CLI · ChatGPT subscription'],['claude-code','Claude Code CLI · Claude subscription']]) {
  await choose(label);
  assert(!document.querySelector('[aria-label="chat API key"]'), 'API key hidden');
  assert(!document.querySelector('[aria-label="chat API base URL"]'), 'API endpoint hidden');
  assert(document.querySelector('[aria-label="chat model"]').value==='default','CLI default selected');
  const save=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='Save chat settings');save.click();
  await until(async()=> (await invoke('ai_config')).chat.kind===kind, 'saved provider');
  const c=await invoke('ai_config');
  assert(c.chat.cliInstalled===true && c.chat.local===false && !c.chat.hasKey,'CLI availability and remote privacy');
  assert(c.embedding.kind==='builtin','Embedding provider independent');
}
passed.push('Both CLI providers save through native Settings; embedding settings remain independent');
await invoke('import_documents',{paths:[`${config.root}/synthetic.md`]});
await invoke('ai_index');
await until(async()=>{const s=await invoke('ai_status');if(s.job?.status==='failed')throw Error(s.job.message);return s.job?.status==='complete';},'GPU indexing');
const status=await invoke('ai_status');
assert(status.indexed===1 && status.dimensions===1024,'Local document indexed');
assert(status.device?.startsWith('GPU'),'Actual GPU offload reported');
await until(()=>document.querySelector('.ai-index')?.textContent.includes('Processing on GPU'),'GPU device displayed');
passed.push(`Native indexing succeeds and shows ${status.device}`);
return {passed,status};
