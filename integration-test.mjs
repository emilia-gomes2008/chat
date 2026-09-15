import { WebSocket } from 'ws';
const BASE = 'http://localhost:3000';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); ok ? pass++ : fail++; };

// 1. Static assets still serve
const overlay = await fetch(`${BASE}/overlay?liveId=TEST`);
const html = await overlay.text();
check('/overlay serves', overlay.status === 200);
check('overlay has viewer-count element', html.includes('id="viewer-count"'));
check('overlay has vc-number span', html.includes('vc-number'));

const setup = await fetch(`${BASE}/`);
const setupHtml = await setup.text();
check('setup screen has the toggle', setupHtml.includes('id="viewers-enabled"'));
check('setup screen has position picker', setupHtml.includes('id="viewers-position"'));

const css = await (await fetch(`${BASE}/css/style.css`)).text();
check('css has position classes', css.includes('.viewer-count.pos-top-right'));
check('css has bump animation', css.includes('vc-bump'));

const js = await (await fetch(`${BASE}/js/chat.js`)).text();
check('client handles viewers message', js.includes("msg.type === 'viewers'"));

// 2. JSON endpoint before any stream is attached
const v1 = await (await fetch(`${BASE}/viewers`)).json();
check('/viewers returns null before start', v1.count === null && v1.live === false, JSON.stringify(v1));

// 3. WebSocket: ask to start a stream (will fail to reach YouTube here),
//    then confirm a *second* client is sent the current viewer state on connect.
const a = new WebSocket('ws://localhost:3000');
await new Promise(r => a.once('open', r));
a.send(JSON.stringify({ type: 'start', liveId: 'dQw4w9WgXcQ' }));
await sleep(1500);

const got = [];
const b = new WebSocket('ws://localhost:3000');
b.on('message', d => got.push(JSON.parse(d.toString())));
await new Promise(r => b.once('open', r));
await sleep(600);

check('new client gets a status message', got.some(m => m.type === 'status'), JSON.stringify(got));
const viewersMsg = got.find(m => m.type === 'viewers');
check('new client gets a viewers message', Boolean(viewersMsg), JSON.stringify(viewersMsg));
check('viewers message carries a count field', viewersMsg && 'count' in viewersMsg);

a.close(); b.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
