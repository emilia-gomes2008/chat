// Diagnose the live viewer count, step by step.
//
//   node diagnose-viewers.mjs UCxxxxxxxxxxxxxxxx      (a channel ID)
//   node diagnose-viewers.mjs dQw4w9WgXcQ            (a video / live ID)
//
// Prints exactly which stage works and which one fails.
import https from 'https';
import zlib from 'zlib';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node diagnose-viewers.mjs <channelId|liveId>');
  process.exit(1);
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const url = arg.startsWith('UC') && arg.length > 20
  ? `https://www.youtube.com/channel/${arg}/live`
  : `https://www.youtube.com/watch?v=${arg}`;

function get(u, left = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (left <= 0) return reject(new Error('too many redirects'));
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, u).href;
        return resolve(get(next, left - 1));
      }
      const enc = res.headers['content-encoding'] || '';
      let st = res;
      if (enc.includes('br')) st = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip')) st = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) st = res.pipe(zlib.createInflate());
      const c = [];
      st.on('data', d => c.push(d));
      st.on('end', () => resolve(Buffer.concat(c).toString('utf-8')));
      st.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function post(u, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const p = new URL(u);
    const req = https.request({
      hostname: p.hostname, path: p.pathname + p.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      const enc = res.headers['content-encoding'] || '';
      let st = res;
      if (enc.includes('br')) st = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip')) st = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) st = res.pipe(zlib.createInflate());
      const c = [];
      st.on('data', d => c.push(d));
      st.on('end', () => {
        const txt = Buffer.concat(c).toString('utf-8');
        try { resolve({ status: res.statusCode, json: JSON.parse(txt) }); }
        catch { resolve({ status: res.statusCode, json: null, raw: txt.slice(0, 300) }); }
      });
      st.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data); req.end();
  });
}

console.log(`\nFetching: ${url}\n`);
let html;
try {
  html = await get(url);
  console.log(`1. Watch page loaded            OK  (${html.length} chars)`);
} catch (e) {
  console.log(`1. Watch page loaded            FAILED: ${e.message}`);
  process.exit(1);
}

const canonical = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([^"]+)"/);
console.log(`2. Resolved video ID            ${canonical ? 'OK  ' + canonical[1] : 'FAILED - not a live page?'}`);
if (!canonical) process.exit(1);

const isReplay = /['"]isReplay['"]:\s*true/.test(html);
console.log(`3. Is this actually live?       ${isReplay ? 'NO - this is a finished stream (replay)' : 'YES'}`);

let idx = 0, blockNum = 0, foundLive = false, liveCount = null;
while (true) {
  const at = html.indexOf('"videoViewCountRenderer"', idx);
  if (at === -1) break;
  idx = at + 24;
  blockNum++;
  const chunk = html.slice(at, at + 1500);
  const live = /"isLive":\s*true/.test(chunk) || /watching/i.test(chunk);
  if (!live) continue;
  foundLive = true;
  const exact = chunk.match(/"originalViewCount":"(\d+)"/);
  const runs = chunk.match(/"runs":\[\{"text":"([^"]+)"/);
  liveCount = exact ? Number(exact[1]) : (runs ? Number(runs[1].replace(/\D/g, '')) : null);
  console.log(`4. Viewer counter in page       FOUND (block #${blockNum} on the page is the live one)`);
  console.log(`5. Marked as live viewership    YES`);
  console.log(`6. originalViewCount            ${exact ? exact[1] : 'absent'}`);
  console.log(`7. Display text                 ${runs ? JSON.stringify(runs[1]) : 'absent'}`);
  break;
}
if (!foundLive) {
  console.log(`4. Viewer counter in page       ${blockNum > 0 ? `found ${blockNum} block(s), none marked live` : 'NOT PRESENT'}`);
  console.log('\n   >> YouTube did not render a live viewer counter into this page.');
  console.log('      Usually means the streamer has the public count hidden.');
} else {
  console.log(`\n   >> Initial count the overlay would show: ${liveCount !== null ? liveCount.toLocaleString() : 'none (found the block but could not read a number out of it)'}`);
}

// Now the polling endpoint
const key = html.match(/['"]INNERTUBE_API_KEY['"]:\s*['"]([^'"]+)['"]/);
const ver = html.match(/['"]clientVersion['"]:\s*['"]([\d.]+)['"]/);
console.log(`\n8. API key / client version     ${key && ver ? `OK  (${ver[1]})` : 'FAILED - could not extract'}`);
if (!key || !ver) process.exit(1);

try {
  const res = await post(`https://www.youtube.com/youtubei/v1/updated_metadata?key=${key[1]}`, {
    context: { client: { clientName: 'WEB', clientVersion: ver[1] } },
    videoId: canonical[1],
  });
  console.log(`9. updated_metadata poll        HTTP ${res.status}`);
  if (!res.json) {
    console.log(`   Response was not JSON: ${res.raw}`);
  } else {
    const actions = res.json.actions || [];
    console.log(`10. Actions returned            ${actions.length} (${actions.map(a => Object.keys(a)[0]).join(', ') || 'none'})`);
    let found = null;
    for (const a of actions) {
      const v = a?.updateViewershipAction?.viewCount?.videoViewCountRenderer;
      if (!v) continue;
      found = v.originalViewCount ?? (v.viewCount?.runs || []).map(r => r.text).join('');
    }
    console.log(`11. Live count from poll        ${found !== null ? found : 'NOT PRESENT'}`);
    console.log(`\n   >> ${found !== null ? `Polling works. Overlay should show ${Number(String(found).replace(/\D/g,'')).toLocaleString()}.` : 'Polling returned no viewer count — count is likely hidden on this stream.'}`);
  }
} catch (e) {
  console.log(`9. updated_metadata poll        FAILED: ${e.message}`);
}
console.log('');
