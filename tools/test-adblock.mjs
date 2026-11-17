// Tests the ad blocker on the Mac with headless Chrome, using the same
// TV user agent and the same app/src/main/assets/adblock.js as the TV app.
//
//   node tools/test-adblock.mjs <videoId> [--no-adblock] [seconds]
//
// Reports: whether YouTube's server scheduled ads (raw player response),
// what the page's player actually received, and any ad shown on screen.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const videoId = process.argv[2] || 'dQw4w9WgXcQ';
const useAdblock = !process.argv.includes('--no-adblock');
const seconds = Number(process.argv.find(a => /^\d+$/.test(a)) || 45);

const UA = 'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)';
const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams', 'adParams', 'no_ads', 'isAd'];
const script = 'window.__ADFREE_RULES=' + JSON.stringify({ adKeys: AD_KEYS }) + ';\n'
  + readFileSync(join(here, '../app/src/main/assets/adblock.js'), 'utf8');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9400 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'adfree-chrome-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--window-size=1920,1080',
  '--no-first-run', '--no-default-browser-check', 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) {
  await sleep(200);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl;
  } catch {}
}
if (!wsUrl) { console.error('Chrome did not start'); chrome.kill(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  else listeners.forEach(l => l(msg));
});
const send = (method, params = {}) => new Promise(r => {
  const id = nextId++; pending.set(id, r); ws.send(JSON.stringify({ id, method, params }));
});

const playerReqs = new Map();
const report = { serverAdKeys: {}, playerResponses: 0, consoleLines: [], adSeenOnScreen: 0 };

listeners.push(async msg => {
  if (msg.method === 'Network.responseReceived' && /\/youtubei\/v1\/player/.test(msg.params.response.url)) {
    playerReqs.set(msg.params.requestId, msg.params.response.url);
  }
  if (msg.method === 'Network.loadingFinished' && playerReqs.has(msg.params.requestId)) {
    const r = await send('Network.getResponseBody', { requestId: msg.params.requestId });
    const body = r.result?.body || '';
    report.playerResponses++;
    for (const k of ['adPlacements', 'playerAds', 'adSlots']) {
      const n = (body.match(new RegExp('"' + k + '"', 'g')) || []).length;
      if (n) report.serverAdKeys[k] = (report.serverAdKeys[k] || 0) + n;
    }
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    if (text.startsWith('[AdFreeTV]')) report.consoleLines.push(text);
  }
});

await send('Network.enable');
await send('Runtime.enable');
await send('Page.enable');
await send('Network.setUserAgentOverride', { userAgent: UA });
if (useAdblock) await send('Page.addScriptToEvaluateOnNewDocument', { source: script });
await send('Page.navigate', { url: `https://www.youtube.com/tv#/watch?v=${videoId}` });

const AD_PROBE = `(() => {
  const ad = document.querySelector('.ad-showing,.ad-interrupting,ytlr-ad-badge-renderer,ytlr-ad-preview-renderer,ytlr-skip-ad-renderer,ytlr-player-ad-overlay-renderer,[class*="ytlr-ad-"]');
  const v = document.querySelector('video');
  return JSON.stringify({ ad: !!ad, adTag: ad ? ad.tagName + '.' + ad.className : null,
    playing: !!(v && !v.paused), t: v ? Math.round(v.currentTime) : null, dur: v ? Math.round(v.duration) : null,
    title: document.title });
})()`;

let last;
for (let s = 0; s < seconds; s += 3) {
  await sleep(3000);
  const r = await send('Runtime.evaluate', { expression: AD_PROBE, returnByValue: true });
  try { last = JSON.parse(r.result.result.value); } catch { continue; }
  if (last.ad) { report.adSeenOnScreen++; console.log(`  [${s}s] AD ON SCREEN: ${last.adTag}`); }
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
const shotPath = join(profile, 'final.png');
(await import('node:fs')).writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'));

console.log(JSON.stringify({
  mode: useAdblock ? 'WITH ad blocker' : 'WITHOUT ad blocker (baseline)',
  video: videoId,
  playerResponses: report.playerResponses,
  adsScheduledByServer: report.serverAdKeys,
  adChecksWithAdOnScreen: report.adSeenOnScreen,
  finalState: last,
  adblockLog: report.consoleLines.slice(0, 12),
  screenshot: shotPath,
}, null, 2));

ws.close();
chrome.kill();
process.exit(0);
