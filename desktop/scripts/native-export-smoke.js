// Native export/save-dialog smoke check. Run with the same debug runner as native-player-smoke.js.
// When GTK's save dialog opens, save into the scratch root, then verify with ffprobe.
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, why, tries = 150) => {
  for (let i = 0; i < tries; i++) { if (fn()) return; await sleep(100); }
  throw Error(`Timed out: ${why}`);
};
location.hash = `#/recording/${encodeURIComponent(config.id)}?t=90`;
await until(() => document.querySelector('video')?.readyState >= 2, 'media ready');
const data = await invoke('recording', { id: config.id });
const index = data.segments.findIndex(s => s.start >= 90);
const rows = document.querySelectorAll('.t-text');
const range = document.createRange();
range.setStart(rows[index].firstChild, 0);
range.setEnd(rows[index + 2].firstChild, rows[index + 2].firstChild.length);
const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
await until(() => !!document.querySelector('.range-bar'), 'selection');
document.querySelector('.range-bar [aria-label=Copy]').click();
await until(() => document.body.textContent.includes('Passage copied'), 'native Copy');
// Read back using wl-paste while the GTK save dialog is open; WebKit disallows readText without a gesture.
document.querySelector('.range-bar [aria-label=Export]').click();
await until(() => !!document.querySelector('.export-dialog'), 'export dialog');
[...document.querySelectorAll('.choice-card')].find(b => b.textContent.startsWith('M4A audio')).click();
await sleep(100);
[...document.querySelectorAll('.dialog-foot button')].find(b => b.textContent === 'Export…').click();
await until(() => !!document.querySelector('.toast-success .toast-message')?.textContent.startsWith('Exported'), 'GTK save and export', 1800);
const file = document.querySelector('.toast-success .toast-message').textContent;
document.querySelector('.toast-success .toast-action').click();
await sleep(1000);
const error = document.querySelector('.toast-error .toast-message')?.textContent;
if (error) throw Error(error);
return { passed: ['Native GTK save dialog', 'M4A export through the real range dialog', 'Show in folder command completed'], file, expectedDuration: data.segments[index + 2].end - data.segments[index].start };
