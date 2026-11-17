// End-to-end check on the Mac (headless Chrome) of: auto guest, sidebar, ads,
// history recording, History page. Screenshots go to $TMPDIR.
//   node tools/test-features.mjs
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.TMPDIR || tmpdir();
const UA = 'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)';
const script = 'window.__ADFREE_RULES=' + JSON.stringify({ adKeys: ['adPlacements','playerAds','adSlots','adBreakHeartbeatParams','adBreakParams','adParams','no_ads','isAd'] }) + ';\n'
  + readFileSync(join(here, '../app/src/main/assets/adblock.js'), 'utf8');
const port = 9600 + Math.floor(Math.random() * 90);
const prof = mkdtempSync(join(OUT, 'feat-'));
const ch = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms)); let ws;
for (let i = 0; i < 50 && !ws; i++) { await sleep(200); try { const l = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const u = l.find(t => t.type === 'page')?.webSocketDebuggerUrl; if (u) ws = new WebSocket(u); } catch {} }
await new Promise(r => ws.addEventListener('open', r)); let id = 1; const pend = new Map(); const logs = [];
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else if (m.method === 'Runtime.consoleAPICalled') { const t = m.params.args.map(a => a.value ?? '').join(' '); if (t.startsWith('[AdFreeTV]')) logs.push(t); } });
const send = (method, params = {}) => new Promise(r => { const i = id++; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.result.value;
const key = async (k, code, text) => { await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: k, windowsVirtualKeyCode: code, text }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: code }); await sleep(600); };
const shot = async name => { const s = await send('Page.captureScreenshot', { format: 'png' }); const p = join(OUT, name + '.png'); writeFileSync(p, Buffer.from(s.result.data, 'base64')); return p; };
const sidebar = () => ev(`[...document.querySelectorAll('ytlr-guide-entry-renderer')].map(e=>e.getAttribute('aria-label')||e.innerText.trim()).filter(Boolean).join(', ')`);
const result = {};
await send('Page.enable'); await send('Runtime.enable'); await send('Network.setUserAgentOverride', { userAgent: UA });
await send('Page.addScriptToEvaluateOnNewDocument', { source: script });
await send('Page.navigate', { url: 'https://www.youtube.com/tv' });
await sleep(16000);
result.welcomeScreenGone = !(await ev(`/Watch as guest/.test(document.body.innerText)`));
result.sidebar = await sidebar();
result.homeShot = await shot('1-home');
// search "arijit" via the Search entry
await key('ArrowLeft', 37); for (let i = 0; i < 8; i++) await key('ArrowUp', 38);
await key('ArrowDown', 40); await key('Enter', 13); await sleep(2500);
for (const c of 'arijit singh') await key(c === ' ' ? ' ' : c, c === ' ' ? 32 : c.toUpperCase().charCodeAt(0), c);
await sleep(5000);
// watch a video (ads check too)
await send('Page.navigate', { url: 'https://www.youtube.com/tv#/watch?v=JGwWNGJdvx8' }); await sleep(14000);
result.adOnScreenDuringVideo = await ev(`!!document.querySelector('.ad-showing,.ad-interrupting')`);
result.videoTime = await ev(`(document.querySelector('video')||{}).currentTime|0`);
result.history = await ev(`localStorage.getItem('adfree.history.v1')`);
// open History from the sidebar
await send('Page.navigate', { url: 'https://www.youtube.com/tv#/' }); await sleep(7000);
result.sidebarAfterReload = await sidebar();
await key('ArrowLeft', 37); for (let i = 0; i < 8; i++) await key('ArrowUp', 38);
const labels = (result.sidebarAfterReload || '').split(', ');
const histIdx = labels.indexOf('History');
const startIdx = labels[0] === 'Sign in' ? 0 : 0;
for (let i = startIdx; i < histIdx; i++) await key('ArrowDown', 40);
await key('Enter', 13); await sleep(2500);
result.historyPageOpen = await ev(`!!document.getElementById('adfree-h')`);
result.historyShot = await shot('2-history');
await key('ArrowRight', 39); await key('ArrowLeft', 37); await key('Enter', 13); await sleep(4000);
result.historyCardOpened = await ev('location.hash');
result.historyClosed = !(await ev(`!!document.getElementById('adfree-h')`));
result.logs = logs.filter(l => !/pruned/.test(l)).slice(0, 6).concat([`(pruned messages: ${logs.filter(l => /pruned/.test(l)).length})`]);
console.log(JSON.stringify(result, null, 2));
ws.close(); ch.kill(); process.exit(0);
