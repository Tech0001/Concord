// Executed inside the actual Tauri webview by the debug-only smoke runner.
// Never use a real library: see docs/HANDOFF.md for the scratch database procedure.
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (ok, why) => { if (!ok) throw Error(why); };
const until = async (fn, why, tries = 100) => {
  for (let i = 0; i < tries; i++) { if (await fn()) return; await sleep(100); }
  throw Error(`Timed out: ${why}`);
};
const passed = [];
window.__concordSmokePassed = passed;
const at = 90;
location.hash = `#/recording/${encodeURIComponent(config.id)}?t=${at}`;
await until(() => document.querySelector('video')?.readyState >= 2, 'native media ready');
const media = document.querySelector('video');
media.muted = true;
await until(() => Math.abs(media.currentTime - at) < 0.5, 'initial timestamp');
const data = await invoke('recording', { id: config.id });
const groups = new Set(data.assignments.map(a => a.speaker_id ? `person:${a.speaker_id}` : `local:${a.local_id}`));
const tabs = () => [...document.querySelectorAll('.pane-switch button')];
if (tabs().length) {
  tabs().find(b => b.textContent.startsWith('Speakers')).click();
  await until(() => !!document.querySelector('.voice-row'), 'speaker pane');
}
assert(document.querySelectorAll('.voice-row').length === groups.size, `speaker grouping: ${document.querySelectorAll('.voice-row').length} rows, ${groups.size} people, viewport ${innerWidth}`);
if (tabs().length) {
  tabs().find(b => b.textContent === 'Transcript').click();
  await until(() => !!document.querySelector('.t-time'), 'transcript pane');
}
passed.push('native resume/explicit timestamp and saved-person grouping');

const index = data.segments.findIndex(s => s.start >= at);
const stamp = document.querySelector(`[data-line="${index}"] .t-time`);
stamp.click();
await until(() => !media.paused && !!document.querySelector('.transport [aria-label=Pause]'), 'native timestamp click plays');
assert(!document.querySelector('.video-play'), 'playing overlay must disappear');
const begin = media.currentTime;
await sleep(35000); // Cross the prior 4 MiB cutoff on the regression recording.
assert(!media.paused && media.currentTime > begin + 25 && media.currentTime < begin + 45, 'native playback must continue after seeking');
assert(Number(document.querySelector('[aria-label="Playback position"]').getAttribute('aria-valuenow')) > begin + 25, 'native playhead must advance');
document.querySelector('.transport [aria-label=Pause]').click();
await until(() => media.paused && !!document.querySelector('.video-play'), 'native pause');
passed.push('native timestamp playback, advancing clock/playhead, overlay, pause, continued streaming');

const rows = document.querySelectorAll('.t-text');
const selection = document.getSelection();
const textRange = document.createRange();
textRange.setStart(rows[index].firstChild, 0);
textRange.setEnd(rows[index + 2].firstChild, rows[index + 2].firstChild.length);
selection.removeAllRanges(); selection.addRange(textRange);
await until(() => !!document.querySelector('.range-bar'), 'native text selection');
assert(document.querySelectorAll('.t-line.is-in-range').length === 3, 'native text selection should select three lines');
const bar = () => document.querySelector('.range-bar');
bar().querySelector('[aria-label=Play]').click();
await until(() => !media.paused && !!bar().querySelector('[aria-label=Stop]'), 'native range playback');
const end = data.segments[index + 2].end;
media.currentTime = end - 0.05;
await until(() => media.paused, 'native range stops');
bar().querySelector('[aria-label=Loop]').click();
bar().querySelector('[aria-label=Play]').click();
await until(() => !media.paused, 'native loop plays');
media.currentTime = end - 0.05;
await until(() => media.currentTime < data.segments[index].start + 2 && !media.paused, 'native loop restarts');
bar().querySelector('[aria-label=Stop]').click();
passed.push('native text selection, range play/stop and loop');

const scroll = document.querySelector('.transcript-scroll');
scroll.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 200 }));
scroll.scrollTop = 1500;
const y = scroll.scrollTop;
media.currentTime = at + 60;
await sleep(250);
assert(scroll.scrollTop === y, 'manual scroll must suspend follow');
stamp.click();
await until(() => !media.paused && Math.abs(media.currentTime - data.segments[index].start) < 3 && !!document.querySelector('.transport [aria-label=Pause]'), 'timestamp after selection');
document.querySelector('.transport [aria-label=Pause]').click();
passed.push('native manual scroll and timestamp after text selection');

bar().querySelector('[aria-label=Copy]').click();
await until(() => document.body.textContent.includes('Passage copied'), 'native Copy action');
const text = await invoke('transcript_text', { id: config.id, start: data.segments[index].start, end, format: 'txt' });
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
const clipboardSha256 = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
bar().querySelector('[aria-label=Export]').click();
await until(() => !!document.querySelector('[role=dialog]'), 'native export dialog opens');
passed.push('native Copy action and export options dialog');
const position = media.currentTime;
location.hash = '#/library';
await sleep(500);
const saved = await invoke('recording', { id: config.id });
assert(Math.abs(saved.media.position - position) < 1, 'leaving recording must preserve position');
passed.push('native persisted resume after leaving');
return { passed, clipboardSha256, secondsPlayed: 35, position, limits: ['GTK save dialog and file-manager reveal require a separate OS-level check'] };
