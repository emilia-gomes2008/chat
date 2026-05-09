import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { LiveChat } from './live-chat.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import https from 'https';
import zlib from 'zlib';

// Bun compiled binaries use a virtual FS (B:\~BUN\root\ on Windows) for import.meta.url.
// That path doesn't exist on disk, so fall back to the directory of the running executable.
const _metaDir = dirname(fileURLToPath(import.meta.url));
const __dirname = existsSync(_metaDir) ? _metaDir : dirname(process.execPath);
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

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
let liveChat = null;
let currentConfig = null;
let retryTimer = null;
let retryCount = 0;
let sessionId = 0; // incremented on each startChat to discard stale events

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

// ── YouTube chat connection with auto-retry ───────────────────────
async function startChat(config) {
  if (liveChat) { liveChat.stop(); liveChat = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  currentConfig = config;
  const mySession = ++sessionId;

  try {
    liveChat = new LiveChat(config);

    liveChat.on('chat', async (item) => {
      if (sessionId !== mySession) return;
      retryCount = 0;

      console.log('[ITEM]', JSON.stringify({
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
      if (!message.trim() && !parts.some(p => p.t === 'img' && p.src) && !item.superchat) return;

      const avatarUrl = item.author.thumbnail?.url;
      const badgeUrl  = item.author.badge?.thumbnail?.url;
      broadcast({
        type: 'chat',
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
      });
    });

    liveChat.on('delete', (id) => {
      if (sessionId !== mySession) return;
      broadcast({ type: 'delete', id });
    });

    liveChat.on('error', (err) => {
      const msg = err?.message || String(err);
      console.error('[chat error]', msg);
    });

    liveChat.on('end', () => {
      console.log('[chat] Stream ended or disconnected — scheduling retry');
      broadcast({ type: 'status', status: 'reconnecting' });
      scheduleRetry();
    });

    const ok = await liveChat.start();
    if (!ok) {
      console.log('[chat] Could not connect — stream may not be live yet');
      broadcast({ type: 'status', status: 'waiting', message: 'Waiting for live stream…' });
      scheduleRetry();
    } else {
      console.log('[chat] Connected to live chat!');
      broadcast({ type: 'status', status: 'connected' });
    }
  } catch (err) {
    console.error('[chat] Startup error:', err.message);
    broadcast({ type: 'status', status: 'error', message: err.message });
    scheduleRetry();
  }
}

function scheduleRetry() {
  if (retryTimer) return;
  retryCount++;
  // Gradual back-off: 5 s, 10 s, 20 s … max 60 s
  const delay = Math.min(5000 * Math.pow(1.5, retryCount - 1), 60000);
  console.log(`[chat] Retrying in ${Math.round(delay / 1000)} s…`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (currentConfig) startChat(currentConfig);
  }, delay);
}

// ── WebSocket clients ─────────────────────────────────────────────
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'start') {
        retryCount = 0;
        const config = msg.channelId
          ? { channelId: msg.channelId }
          : msg.liveId
          ? { liveId: msg.liveId }
          : null;
        if (config) startChat(config);
      }
    } catch { /* ignore malformed messages */ }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));

  // Send current connection status to newly joined client
  if (currentConfig) {
    ws.send(JSON.stringify({ type: 'status', status: liveChat ? 'connected' : 'reconnecting' }));
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
server.listen(3000, '0.0.0.0', () => {
  console.log('YouTube Live Chat overlay: http://localhost:3000');
});
