// Run AdFree TV on the Mac: opens YouTube's TV interface full-screen in its
// own Chrome window (separate profile, guest mode), with the same TV user
// agent and the same ad blocker (app/src/main/assets/adblock.js) as the TV app.
//
//   node tools/run-on-mac.mjs
//
// Keys: arrows = move, Enter = select, Esc = back. Quit with Cmd+Q.
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)';
const AD_KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams', 'adParams', 'no_ads', 'isAd'];
const script = 'window.__ADFREE_RULES=' + JSON.stringify({ adKeys: AD_KEYS }) + ';\n'
  + readFileSync(join(here, '../app/src/main/assets/adblock.js'), 'utf8');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = join(homedir(), 'Library/Application Support/AdFreeTV-Chrome');
mkdirSync(profile, { recursive: true });
const port = 9555;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pageWsUrl() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return list.find(t => t.type === 'page' && !t.url.startsWith('devtools'))?.webSocketDebuggerUrl;
  } catch { return undefined; }
}

// Already open (maybe hidden on another desktop or behind other windows)?
// Close that window and start a fresh one in front of you.
let wsUrl = await pageWsUrl();
if (wsUrl) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const b = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise(r => b.addEventListener('open', r));
    b.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
  } catch {}
  for (let i = 0; i < 50 && await pageWsUrl(); i++) await sleep(200);
  await sleep(500);
  wsUrl = undefined;
}
{
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--user-agent=${UA}`, '--autoplay-policy=no-user-gesture-required',
    '--start-fullscreen', '--no-first-run', '--no-default-browser-check',
    // Smoother on Mac: GPU drawing, no throttling of the TV app's animations.
    '--enable-gpu-rasterization', '--enable-zero-copy', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--app=about:blank',
  ], { stdio: 'ignore' });
  chrome.on('exit', () => process.exit(0));
  for (let i = 0; i < 75 && !wsUrl; i++) { await sleep(200); wsUrl = await pageWsUrl(); }
  if (!wsUrl) { console.error('Could not start Chrome.'); chrome.kill(); process.exit(1); }
}

const ws = new WebSocket(wsUrl);
await new Promise(r => ws.addEventListener('open', r));
let id = 1;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: id++, method, params }));
send('Network.setUserAgentOverride', { userAgent: UA });
send('Page.enable');
send('Page.addScriptToEvaluateOnNewDocument', { source: script });
send('Page.navigate', { url: 'https://www.youtube.com/tv' });
// The ad blocker lives as long as this launcher does: keep it running.
ws.addEventListener('close', () => process.exit(0));
console.log('AdFree TV is open. Keep this terminal open; quit with Cmd+Q in the window.');
