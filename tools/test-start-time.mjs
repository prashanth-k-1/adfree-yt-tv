// Measures how long a video takes to start (Mac, headless Chrome, fresh profile).
//   node tools/test-start-time.mjs <videoId> [--no-adblock]
// Prints a timeline: page load, player data, first frame, ad shown, network
// requests that were slow, and our script's activity.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const vid = process.argv[2] || 'kJQP7kiw5Fk';
const adblock = !process.argv.includes('--no-adblock');
const UA = 'Mozilla/5.0 (PS4; Leanback Shell) Gecko/20100101 Firefox/65.0 LeanbackShell/01.00.01.75 Sony PS4/ (PS4, , no, CH)';
const script = 'window.__ADFREE_RULES={"adKeys":["adPlacements","playerAds","adSlots","adBreakHeartbeatParams","adBreakParams","adParams","no_ads","isAd"]};\n' + readFileSync(join(here, '../app/src/main/assets/adblock.js'), 'utf8');
const probe = `window.__t0=performance.now();window.__ev=[];(function(){function mark(n){__ev.push(n+'@'+Math.round(performance.now()))}
var seen=false;new MutationObserver(function(){var v=document.querySelector('video');if(v&&!v.__m){v.__m=1;mark('video-element');['loadstart','loadeddata','playing','waiting','pause'].forEach(function(e){v.addEventListener(e,function(){mark('video-'+e+'(t='+v.currentTime.toFixed(1)+')')})})}
var ad=document.querySelector('.ad-showing');if(ad&&!seen){seen=true;mark('AD-SHOWN')}}).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});})();`;
const OUT = process.env.TMPDIR || tmpdir();
const port = 9100 + Math.floor(Math.random()*90); const prof = mkdtempSync(join(OUT,'st-'));
const ch = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new',`--remote-debugging-port=${port}`,`--user-data-dir=${prof}`,'--mute-audio','--autoplay-policy=no-user-gesture-required','--window-size=1920,1080','about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms)); let ws;
for(let i=0;i<50&&!ws;i++){await sleep(200);try{const l=await (await fetch(`http://127.0.0.1:${port}/json`)).json();const u=l.find(t=>t.type==='page')?.webSocketDebuggerUrl;if(u)ws=new WebSocket(u)}catch{}}
await new Promise(r=>ws.addEventListener('open',r)); let id=1; const pend=new Map(); const reqs=new Map(); const slow=[]; const logs=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);return}
 if(m.method==='Network.requestWillBeSent')reqs.set(m.params.requestId,{url:m.params.request.url,t:m.params.timestamp});
 if(m.method==='Network.loadingFinished'||m.method==='Network.loadingFailed'){const r=reqs.get(m.params.requestId);if(r){const d=(m.params.timestamp-r.t)*1000;if(d>800&&!/googlevideo|\.js|\.css|ytimg|fonts/.test(r.url))slow.push(Math.round(d)+'ms '+r.url.split('?')[0].slice(0,90)+(m.method==='Network.loadingFailed'?' (FAILED)':''))}}
 if(m.method==='Runtime.consoleAPICalled'){const t=m.params.args.map(a=>a.value??'').join(' ');if(t.startsWith('[AdFreeTV]'))logs.push(t.slice(0,90))}});
const send=(method,params={})=>new Promise(r=>{const i=id++;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
await send('Page.enable'); await send('Network.enable'); await send('Runtime.enable'); await send('Network.setUserAgentOverride',{userAgent:UA});
await send('Page.addScriptToEvaluateOnNewDocument',{source:probe+'\n'+(adblock?script:'')});
const inApp = process.argv.includes('--in-app');
const mix = process.argv.find(a => a.startsWith('--mix='));
if (mix) {
  await send('Page.navigate',{url:`https://www.youtube.com/tv#/watch?v=${vid}&list=${mix.slice(6)}`}); await sleep(15000);
  // jump to 3s before the end so the Mix moves on to the next video by itself
  await send('Runtime.evaluate',{expression:`(()=>{const v=document.querySelector('video');__ev.push('--- near end, hash '+location.hash.slice(0,40)+' @'+Math.round(performance.now()));v.currentTime=v.duration-3;})()`});
  await sleep(25000);
  const h=(await send('Runtime.evaluate',{expression:'location.hash',returnByValue:true})).result.result.value;
  console.log('hash after:', h);
} else if (inApp) {
  await send('Page.navigate',{url:'https://www.youtube.com/tv#/search?q=despacito'}); await sleep(12000);
  await send('Runtime.evaluate',{expression:`__ev.push('--- choose video @'+Math.round(performance.now())); location.hash='#/watch?v=${vid}'`});
  await sleep(30000);
} else {
  await send('Page.navigate',{url:`https://www.youtube.com/tv#/watch?v=${vid}`}); await sleep(35000);
}
const ev=(await send('Runtime.evaluate',{expression:'JSON.stringify({ev:__ev,bot:/not a bot/i.test(document.body.textContent)})',returnByValue:true})).result.result.value;
console.log(JSON.stringify({mode:adblock?'WITH adblock':'WITHOUT adblock',video:vid,...JSON.parse(ev),slowRequests:slow.slice(0,10),adfreeLog:logs.slice(0,8)},null,1));
ws.close(); ch.kill(); process.exit(0);
