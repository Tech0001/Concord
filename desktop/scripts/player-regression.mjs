// UI behavior regressions against Vite's synthetic IPC, with the real HTML media element.
// Run while `pnpm --dir desktop dev` is running: node desktop/scripts/player-regression.mjs
// This complements, and does not replace, the WebKitGTK desktop smoke check.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const port = Number(process.env.CDP_PORT ?? 9334);
const base = process.env.BASE ?? 'http://127.0.0.1:1420/';
const profile = mkdtempSync(join(tmpdir(), 'concord-player-test-'));
const chrome = spawn('chromium', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
let ws;
try {
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); break; }
    catch { await sleep(100); }
  }
  if (!target) throw new Error('Chromium failed to start');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, m => m.error ? reject(Error(m.error.message)) : resolve(m.result));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const js = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, description) => {
    for (let i = 0; i < 100; i++) { if (await js(expression)) return; await sleep(100); }
    throw Error(`Timed out: ${description}`);
  };
  const report = message => console.log(`PASS ${message}`);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}?mock&delay.recording=900&delay.media_file=10#/library` });
  await until('!!document.querySelector(".rec-grid, .rec-list")', 'library');
  await js(`(async () => { window.testApi = (await import('/src/lib/ipc.ts')).api; await testApi.savePosition('rec-01', 75); location.hash = '#/recording/rec-01'; })()`);
  await until('!!document.querySelector(".player-loading")', 'pending transcript');
  await js(`location.hash = '#/library'`);
  await sleep(250);
  assert.equal(await js(`testApi.recording('rec-01').then(r => r.media.position)`), 75);
  report('leaving before media mounts preserves resume position (including StrictMode)');

  await js(`location.hash = '#/recording/rec-01'`);
  await until('document.querySelector("video")?.currentTime >= 74.5', 'resume after late transcript');
  await js(`document.querySelector('.video-play').click()`);
  await until('!!document.querySelector(".transport [aria-label=Pause]")', 'pause control');
  assert.equal(await js('!!document.querySelector(".video-play")'), false);
  const initial = await js('document.querySelector("video").currentTime');
  await until(`document.querySelector('video').currentTime > ${initial + 0.8}`, 'media advances');
  await until(`Number(document.querySelector('[aria-label="Playback position"]').getAttribute('aria-valuenow')) > ${Math.floor(initial)}`, 'UI playhead advances');
  await js(`document.querySelector('.transport [aria-label=Pause]').click()`);
  await until('document.querySelector("video").paused', 'pause');
  report('late transcript mounts attach media listeners: play/pause, overlay, clock, timeline');

  await js(`location.hash = '#/recording/rec-01?t=145'`);
  await until('Math.abs(document.querySelector("video").currentTime - 145) < 0.5', 'same recording navigation');
  report('new timestamp on the same recording seeks');

  await js(`(() => {
    const rows = document.querySelectorAll('.t-text');
    const r = document.createRange(); r.setStart(rows[4].firstChild, 0); r.setEnd(rows[6].firstChild, rows[6].firstChild.length);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(r);
  })()`);
  await until('!!document.querySelector(".range-bar")', 'text selection range');
  assert.ok(await js('document.querySelectorAll(".t-line.is-in-range").length >= 3'));
  const timestamp = await js(`Number(document.querySelector('[data-line="10"] .t-time').textContent.split(':').reduce((t, n) => t * 60 + Number(n), 0))`);
  await js(`document.querySelector('[data-line="10"] .t-time').click()`);
  await until(`Math.abs(document.querySelector('video').currentTime - ${timestamp}) < 2 && !document.querySelector('video').paused`, 'timestamp while text selected');
  report('text selection creates line range; timestamp still seeks and plays');

  await js(`document.querySelector('.transport [aria-label=Pause]').click(); window.__concordTest.selectRange(1, 2); document.querySelector('.range-bar [aria-label=Play]').click()`);
  await until('!!document.querySelector(".range-bar [aria-label=Stop]")', 'range plays');
  const end = await js(`Number(document.querySelector('[aria-label="Range end"]').getAttribute('aria-valuenow'))`);
  await js(`document.querySelector('video').currentTime = ${end - 0.1}`);
  await until('document.querySelector("video").paused && !!document.querySelector(".range-bar [aria-label=Play]")', 'range stops');
  await js(`document.querySelector('.range-bar [aria-label=Loop]').click(); document.querySelector('.range-bar [aria-label=Play]').click()`);
  const start = await js(`Number(document.querySelector('[aria-label="Range start"]').getAttribute('aria-valuenow'))`);
  await js(`document.querySelector('video').currentTime = ${end - 0.1}`);
  await until(`document.querySelector('video').currentTime < ${start + 2} && !document.querySelector('video').paused`, 'range loops');
  await js(`document.querySelector('.range-bar [aria-label=Stop]').click()`);
  report('range playback stops at end and loop restarts at beginning');

  await js(`(() => { const pane = document.querySelector('.transcript-scroll'); pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 300 })); pane.scrollTop = 1200; })()`);
  const scroll = await js('document.querySelector(".transcript-scroll").scrollTop');
  await js(`document.querySelector('video').currentTime = 250`);
  await sleep(300);
  assert.equal(await js('document.querySelector(".transcript-scroll").scrollTop'), scroll);
  report('manual transcript scrolling suspends follow and stays put');

  await js(`document.querySelector('video').currentTime = 165`);
  await sleep(200);
  await js(`location.hash = '#/library'`);
  await sleep(200);
  assert.ok(Math.abs(await js(`testApi.recording('rec-01').then(r => r.media.position)`) - 165) < 1);
  report('leaving a loaded recording saves the real playback position');
} finally {
  ws?.close();
  const stopped = new Promise(resolve => chrome.once('exit', resolve));
  chrome.kill(); await stopped;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
