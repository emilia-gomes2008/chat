import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { LiveChat } from './live-chat.js';
import { TwitchChat } from './platforms/twitch.js';
import { TikTokChat } from './platforms/tiktok.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';
import zlib from 'zlib';

// Bun compiled binaries: Bun global exists and argv[1] is not a .js script.
// In that case import.meta.url points to a virtual FS (B:\~BUN\root\) — use execPath instead.
const _isCompiledBun = typeof Bun !== 'undefined' && !process.argv[1]?.endsWith('.js');
// Non-compiled runs execute this file from server/, so the project root is one level up.
const __dirname = _isCompiledBun
  ? dirname(process.execPath)
  : join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Log every single HTTP request that reaches this process — including the
// raw upgrade attempt for the WebSocket — so there is no blind spot left
// about what is or isn't actually hitting this server.
app.use((req, res, next) => {
  console.log(`[http] ${req.method} ${req.url}`);
  next();
});
server.on('upgrade', (req) => {
  console.log(`[http] WS upgrade request: ${req.url}`);
});

app.use(express.static(join(__dirname, 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') || filePath.endsWith('.css') || filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

// Fetch a YouTube channel avatar by @handle — used by demo mode
function fetchAvatar(handle, res) {
  const url = `https://www.youtube.com/@${handle}`;
  const request = https.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  }, (pageRes) => {
    // Follow one redirect (YouTube sometimes redirects @handle → /channel/UC...)
    if (pageRes.statusCode >= 300 && pageRes.statusCode < 400 && pageRes.headers.location) {
      pageRes.resume();
      const loc = pageRes.headers.location;
      const redirectHandle = loc.match(/\/@([^/?]+)/)?.[1];
      if (redirectHandle && redirectHandle !== handle) return fetchAvatar(redirectHandle, res);
      return res.status(404).end();
    }

    // Decompress the response
    const enc = pageRes.headers['content-encoding'] || '';
    let stream = pageRes;
    if (enc.includes('br'))     stream = pageRes.pipe(zlib.createBrotliDecompress());
    else if (enc.includes('gzip')) stream = pageRes.pipe(zlib.createGunzip());
    else if (enc.includes('deflate')) stream = pageRes.pipe(zlib.createInflate());

    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => {
      const html = Buffer.concat(chunks).toString('utf-8');

      // 1. og:image meta tag
      let m = html.match(/<meta property="og:image" content="([^"]+)"/);
      if (m) return res.json({ url: m[1] });

      // 2. Avatar URL inside ytInitialData JSON (yt3.googleusercontent.com)
      m = html.match(/"(https:\/\/yt3\.googleusercontent\.com\/[^"]+)"/);
      if (m) return res.json({ url: m[1].replace(/\\u003d/g, '=') });

      // 3. Older ggpht.com format
      m = html.match(/"(https:\/\/yt3\.ggpht\.com\/[^"]+)"/);
      if (m) return res.json({ url: m[1] });

      res.status(404).json({ error: 'Avatar not found' });
    });
    stream.on('error', () => res.status(500).end());
  });
  request.on('error', () => res.status(500).end());
  request.setTimeout(8000, () => { request.destroy(); res.status(504).end(); });
}

app.get('/avatar', (req, res) => {
  const handle = (req.query.handle || '').replace(/^@/, '');
  if (!handle) return res.status(400).end();
  fetchAvatar(handle, res);
});

// Proxy YouTube avatar images to avoid CORS issues in browser sources
app.get('/proxy', (req, res) => {
  const url = req.query.url;
  if (!url || !url.startsWith('https://')) return res.status(400).end();
  const request = https.get(url, (imgRes) => {
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    imgRes.pipe(res);
  });
  request.on('error', () => res.status(500).end());
  request.setTimeout(5000, () => { request.destroy(); res.status(504).end(); });
});

// ── State ─────────────────────────────────────────────────────────
const clients = new Set();
let sessionId = 0; // incremented on each startAll to discard stale events

const PLATFORMS = ['youtube', 'twitch', 'tiktok'];
// Per-platform connection state, so any combination can run at once.
const platformState = {
  youtube: { instance: null, config: null, retryTimer: null, retryCount: 0 },
  twitch:  { instance: null, config: null, retryTimer: null, retryCount: 0 },
  tiktok:  { instance: null, config: null, retryTimer: null, retryCount: 0 },
};
// Last known viewer count per platform — combined into one number for the overlay.
const viewerCounts = { youtube: null, twitch: null, tiktok: null };

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

// ── Emoji image cache (fetched server-side → sent as base64) ─────
const emojiCache = new Map();

function fetchBase64(url) {
  if (emojiCache.has(url)) return Promise.resolve(emojiCache.get(url));
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://www.youtube.com/',
      },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const type = res.headers['content-type'] || 'image/png';
        const data = `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
        if (emojiCache.size < 1000) emojiCache.set(url, data);
        resolve(data);
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}

// ── Normalize one platform's raw chat item into the wire message ──
// Every platform connector (LiveChat, TwitchChat, TikTokChat) emits items
// shaped the same way (author/message/isModerator/etc.), so this one
// function builds the broadcastable message for all three.
async function buildChatMessage(item, platform) {
  console.log('[ITEM]', JSON.stringify({
    platform,
    id: item.id,
    author: item.author?.name,
    channelId: item.author?.channelId,
    isOwner: item.isOwner,
    isModerator: item.isModerator,
    isMembership: item.isMembership,
    msgLength: item.message?.length,
  }));

  const isMod    = item.isModerator  || false;
  const isMember = item.isMembership || false;
  const role = isMod ? 'mod' : isMember ? 'member' : 'chatter';

  const rawParts = (item.message || []).map(p => {
    // Any emoji/image with a URL → fetch as image (covers custom, member and YouTube platform emojis)
    if (p.url) return { t: 'img', url: p.url, alt: p.emojiText || p.alt || '' };
    if (p.emojiText) return { t: 'text', v: p.emojiText };
    if (p.text)      return { t: 'text', v: p.text };
    return null;
  }).filter(Boolean);

  const parts = await Promise.all(rawParts.map(async p => {
    if (p.t !== 'img') return p;
    const src = await fetchBase64(p.url);
    return { t: 'img', src: src || null, alt: p.alt };
  }));

  const message = parts.map(p => p.v || p.alt || '').join('');
  if (!message.trim() && !parts.some(p => p.t === 'img' && p.src) && !item.superchat) return null;

  const avatarUrl = item.author.thumbnail?.url;
  const badgeUrl  = item.author.badge?.thumbnail?.url;
  return {
    type: 'chat',
    platform,
    id: item.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    author: item.author.name || 'Anonymous',
    avatar: avatarUrl ? `/proxy?url=${encodeURIComponent(avatarUrl)}` : '',
    badgeIcon: badgeUrl ? `/proxy?url=${encodeURIComponent(badgeUrl)}` : null,
    parts,
    message,
    timestamp: item.timestamp instanceof Date ? item.timestamp.getTime() : Date.now(),
    role,
    superchat: item.superchat
      ? { amount: item.superchat.amount, color: item.superchat.color }
      : null,
  };
}

function broadcastViewerTotal() {
  const known = Object.values(viewerCounts).filter(v => v !== null);
  if (!known.length) return;
  broadcast({ type: 'viewerCount', count: known.reduce((a, b) => a + b, 0) });
}

function stopPlatform(name) {
  const s = platformState[name];
  if (s.instance) { try { s.instance.stop(); } catch { /* already gone */ } s.instance = null; }
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
  s.config = null;
  s.retryCount = 0;
  viewerCounts[name] = null;
}

function scheduleRetry(name, mySession) {
  const s = platformState[name];
  if (s.retryTimer) return;
  s.retryCount++;
  // Gradual back-off: 5 s, 10 s, 20 s … max 60 s
  const delay = Math.min(5000 * Math.pow(1.5, s.retryCount - 1), 60000);
  console.log(`[${name}] Retrying in ${Math.round(delay / 1000)} s…`);
  s.retryTimer = setTimeout(() => {
    s.retryTimer = null;
    if (sessionId === mySession && s.config) startPlatform(name, s.config, mySession);
  }, delay);
}

// ── Single-platform connection with auto-retry ─────────────────────
async function startPlatform(name, config, mySession) {
  const s = platformState[name];
  if (s.instance) { try { s.instance.stop(); } catch { /* already gone */ } s.instance = null; }
  if (s.retryTimer) { clearTimeout(s.retryTimer); s.retryTimer = null; }
  s.config = config;

  let instance;
  try {
    if (name === 'youtube') instance = new LiveChat(config);
    else if (name === 'twitch') instance = new TwitchChat(config.channel);
    else if (name === 'tiktok') instance = new TikTokChat(config.username);
    else return;
  } catch (err) {
    console.error(`[${name}] Init error:`, err.message);
    scheduleRetry(name, mySession);
    return;
  }

  s.instance = instance;

  instance.on('chat', async (item) => {
    if (sessionId !== mySession) return;
    s.retryCount = 0;
    const built = await buildChatMessage(item, name);
    if (built) broadcast(built);
  });

  instance.on('delete', (id) => {
    if (sessionId !== mySession) return;
    broadcast({ type: 'delete', id, platform: name });
  });

  instance.on('error', (err) => {
    console.error(`[${name}] error:`, err?.message || err);
  });

  instance.on('viewerCount', (count) => {
    if (sessionId !== mySession) return;
    viewerCounts[name] = count;
    broadcastViewerTotal();
  });

  instance.on('end', () => {
    if (sessionId !== mySession) return;
    console.log(`[${name}] Stream ended or disconnected — scheduling retry`);
    broadcast({ type: 'status', platform: name, status: 'reconnecting' });
    viewerCounts[name] = null;
    scheduleRetry(name, mySession);
  });

  try {
    const ok = await instance.start();
    if (sessionId !== mySession) return;
    if (!ok) {
      console.log(`[${name}] Could not connect — may not be live yet`);
      broadcast({ type: 'status', platform: name, status: 'waiting' });
      scheduleRetry(name, mySession);
    } else {
      console.log(`[${name}] Connected!`);
      broadcast({ type: 'status', platform: name, status: 'connected' });
    }
  } catch (err) {
    if (sessionId !== mySession) return;
    console.error(`[${name}] Startup error:`, err.message);
    broadcast({ type: 'status', platform: name, status: 'error', message: err.message });
    scheduleRetry(name, mySession);
  }
}

// ── Start/stop whichever platforms are in the requested config ─────
// cfg looks like: { youtube?: {channelId|liveId}, twitch?: {channel}, tiktok?: {username} }
// Any subset is valid — this is what makes "YouTube only" / "Twitch only" /
// "all three" all just work off the same code path.
function startAll(cfg) {
  sessionId++;
  const mySession = sessionId;
  for (const name of PLATFORMS) {
    if (cfg[name]) startPlatform(name, cfg[name], mySession);
    else stopPlatform(name);
  }
}

// ── WebSocket clients ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log(`[ws] Browser connected (${clients.size + 1} total).`);
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    console.log('[ws] Message from browser:', raw.toString());
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'start') {
        const cfg = {};
        if (msg.youtube && (msg.youtube.channelId || msg.youtube.liveId)) cfg.youtube = msg.youtube;
        if (msg.twitch && msg.twitch.channel) cfg.twitch = msg.twitch;
        if (msg.tiktok && msg.tiktok.username) cfg.tiktok = msg.tiktok;
        if (Object.keys(cfg).length) startAll(cfg);
        else console.log('[ws] "start" received but had no usable youtube/twitch/tiktok fields:', msg);
      }
    } catch (err) { console.log('[ws] Could not parse message as JSON:', err.message); }
  });

  ws.on('close', () => { console.log(`[ws] Browser disconnected (${clients.size - 1} total).`); clients.delete(ws); });
  ws.on('error', () => clients.delete(ws));

  // Send current connection status per active platform to newly joined client
  for (const name of PLATFORMS) {
    const s = platformState[name];
    if (s.config) {
      ws.send(JSON.stringify({ type: 'status', platform: name, status: s.instance ? 'connected' : 'reconnecting' }));
    }
  }
});

// Heartbeat — detect and remove stale WebSocket connections
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

// ── Overlay route (used by OBS Browser Source) ───────────────────
app.get('/overlay', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('╔══════════════════════════════════════════════════════════════╗');
    console.error('  ERRO: a porta 3000 já está a ser usada por outro programa.');
    console.error('  Provavelmente há outra cópia deste overlay já aberta noutra');
    console.error('  janela (ou a correr escondida em segundo plano).');
    console.error('  Fecha TODAS as janelas/processos "chat-overlay" e tenta de novo.');
    console.error('╚══════════════════════════════════════════════════════════════╝');
  } else {
    console.error('SERVER ERROR:', err.message);
  }
});
server.listen(3000, '0.0.0.0', () => {
  console.log('YouTube Live Chat overlay: http://localhost:3000');
});