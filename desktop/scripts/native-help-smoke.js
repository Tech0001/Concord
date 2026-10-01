// Native WebKitGTK regression. Uses an empty scratch root, empty folder and synthetic local chat provider.
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const until = async (check, label) => {
  for (let i=0;i<400;i++) { if (await check()) return; await sleep(100); }
  throw Error(`Timed out: ${label}`);
};
const click = (text, scope=document) => {
  const button=[...scope.querySelectorAll('button')].find(e=>e.textContent.trim()===text);
  assert(button && !button.disabled,`Available button: ${text}`);button.click();
};
const message = async text => {
  const input=document.querySelector('[aria-label="Message"]');assert(input,'Message input');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);
  input.dispatchEvent(new Event('input',{bubbles:true}));await sleep(100);
};
const mode = async value => {
  const radio=document.querySelector(`input[name="chat-context"][value="${value}"]`);
  assert(radio && !radio.disabled,`Context: ${value}`);radio.click();await sleep(100);
};
const passed=[];window.__concordSmokePassed=passed;
await until(()=>document.querySelector('.setup'),'initial setup');
await invoke('start_library');await invoke('setup_save',{patch:{completed:true}});
location.hash='#/setup?step=speech&return=ai';
await until(()=>document.querySelector('.setup[data-step="speech"] .setup-help'),'speech help');
click('Ask for help',document.querySelector('.setup-help'));
await until(()=>document.querySelector('.setup-connect-options'),'connection prompt');
assert(sessionStorage.getItem('concord.pendingHelp')?.includes('GPU/CPU'),'Help question preserved before connecting');
assert((await invoke('ai_conversations')).length===0,'Help does not send or create a chat before connecting');
await invoke('ai_save_provider',{task:'chat',provider:{enabled:true,kind:'local',baseUrl:config.aiUrl,model:'tiny-help'},key:'FIXTURE_PRIVATE_KEY'});
location.hash='#/library';await until(()=>!document.querySelector('.ai-page'),'leave AI');
location.hash='#/ai';
await until(()=>document.querySelector('[aria-label="Message"]')?.value.includes('GPU/CPU'),'help intent after connection');
assert(document.querySelector('input[value="help"]').checked,'Explicit help selected');
assert(location.hash==='#/ai','Consumed question removed from navigation');
const id=(await invoke('ai_conversations'))[0].id;
assert((await invoke('ai_read_chat',{id})).messages.length===0,'Prefill is not sent automatically');
await until(()=>document.querySelector('[aria-label="App status preview"]')?.textContent.includes('recentErrors'),'local diagnostics preview');
const preview=document.querySelector('[aria-label="App status preview"]').textContent;
assert(!preview.includes(config.root) && !preview.includes('FIXTURE_PRIVATE_KEY'),'No keys or paths in preview');
passed.push('Setup help survives connection, selects shared chat and previews filtered diagnostics without sending');
const sendAndWait=async (count,enter=false)=>{
  if(enter) {
    const key=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
    document.querySelector('[aria-label="Message"]').dispatchEvent(key);
    assert(key.defaultPrevented,'Enter submits instead of inserting a newline');
  } else click('Send',document.querySelector('.chat-composer'));
  await until(async()=>{const d=await invoke('ai_read_chat',{id});return d.messages.length===count && d.messages.at(-1).role==='assistant';},`saved ${count} messages`);
  await until(()=>document.querySelectorAll('.chat-message').length===count && !document.querySelector('[aria-label="Message"]').disabled,'response rendered');
  const d=await invoke('ai_read_chat',{id});assert(d.messages.at(-1).error===0,'Successful response');return d;
};
await sendAndWait(2);
assert(document.querySelector('.chat-message.is-assistant').textContent.includes('Check your source'),'Help reply rendered');
click('Semantic search',document.querySelector('.ai-tabs'));await until(()=>document.querySelector('.ai-index'),'semantic tab');
click('Chat',document.querySelector('.ai-tabs'));await until(()=>document.querySelector('[aria-label="Message"]'),'return chat');
assert(!document.querySelector('[aria-label="Message"]').value,'Sent question is not reinserted after tab switch');
assert((await invoke('ai_conversations')).length===1,'Same conversation after tab switch');
passed.push('Help request and reply persist; tabs reuse the active conversation without re-prefilling sent text');
await mode('none');await message('GENERAL_REQUEST_SENTINEL');
const composer=document.querySelector('[aria-label="Message"]');
for (const options of [{shiftKey:true},{isComposing:true},{keyCode:229}]) {
  const key=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,...options});
  composer.dispatchEvent(key);assert(!key.defaultPrevented,'Shift+Enter and IME composition keep normal input behavior');
}
await sleep(150);assert((await invoke('ai_read_chat',{id})).messages.length===2,'Newline and IME keys do not send');
await message('GENERAL_REQUEST_SENTINEL\nSecond line');await sendAndWait(4,true);
assert((await invoke('ai_read_chat',{id})).messages[2].content.includes('\nSecond line'),'Multiline draft preserved on send');
composer.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
await sleep(100);assert((await invoke('ai_read_chat',{id})).messages.length===4,'Empty Enter does not send');
passed.push('Desktop Enter sends; Shift+Enter and IME keep input behavior; multiline text is preserved and empty input is ignored');
assert(document.querySelectorAll('.chat-message.is-assistant')[1].textContent.includes('GENERAL'),'General reply rendered');
await invoke('import_documents',{paths:[config.root+'/synthetic.md']});
await mode('archive');
const semantic=[...document.querySelectorAll('.chat-composer label')].find(e=>e.textContent.includes('Find sources by meaning')).querySelector('input');
if(semantic.checked)semantic.click();await sleep(100);
await message('ARCHIVE_SENTINEL');const archive=await sendAndWait(6);
assert(archive.messages.at(-1).sources.length===1,'Archive citations still present');
assert(archive.messages.filter(m=>m.role==='user').map(m=>m.context_kind).join(',')==='help,none,archive','Three contexts in one history');
passed.push('Neither and My archive send through the same conversation; archive keeps its source citation');
// A reply link is a navigation button, not an executable command.
click('Sources',document.querySelector('.chat-message.is-assistant'));
await until(()=>document.querySelector('.pipeline-sources'),'help answer link opens Sources');
await invoke('pipeline_save_source',{source:{name:'PRIVATE_SOURCE_SENTINEL',kind:'folder',url:config.root+'/empty',enabled:true,diarize:false,includeShorts:false,category:'personal'}});
location.hash='#/library';await until(()=>!document.querySelector('.pipeline-sources'),'leave sources');
location.hash='#/pipeline?tab=sources';
await until(()=>document.querySelector('.pipeline-source'),'source card');
click('Ask for help',document.querySelector('.pipeline-source'));
await until(()=>document.querySelector('[aria-label="Message"]')?.value.includes('source'),'source question prefilled');
assert(document.querySelector('input[value="help"]').checked,'Source explicitly selects help');
assert((await invoke('ai_conversations')).length===1,'Source help continues the same conversation');
assert((await invoke('ai_read_chat',{id})).messages.length===6,'Source prefill does not send');
await until(()=>document.querySelector('[aria-label="App status preview"]')?.textContent.includes('sourceNumber'),'updated source status');
assert(!document.querySelector('[aria-label="App status preview"]').textContent.includes('PRIVATE_SOURCE_SENTINEL'),'Source names omitted');
await sendAndWait(8);
assert(!(await invoke('pipeline_state')).running,'Help never starts the queue');
assert((await invoke('overview')).media===0,'Help never scans or imports recordings');
passed.push('Answer navigation and source Ask for help work, reuse history and leave the queue paused');
const final=await invoke('ai_read_chat',{id});
return {passed,messages:final.messages.map(m=>({role:m.role,context:m.context_kind,error:m.error})),viewport:{width:innerWidth,height:innerHeight}};
