// Local replacement for youtube-chat with deletion-event support.
// The published youtube-chat@2.2.0 ignores markChatItemAsDeletedAction;
// this module parses those actions and emits a 'delete' event.
import { EventEmitter } from 'events';
import https from 'https';
import zlib from 'zlib';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      // Follow redirects (YouTube redirects /channel/ID/live → /watch?v=ID)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return resolve(fetchText(next, redirectsLeft - 1));
      }

      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('br'))       stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip'))    stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('fetchText timeout')); });
  });
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        'User-Agent': UA,
        'Accept-Encoding': 'gzip, deflate, br',
      },
    }, (res) => {
      const enc = res.headers['content-encoding'] || '';
      let stream = res;
      if (enc.includes('br'))       stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc.includes('gzip'))    stream = res.pipe(zlib.createGunzip());
      else if (enc.includes('deflate')) stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch { reject(new Error('Invalid JSON response')); }
      });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('postJson timeout')); });
    req.write(data);
    req.end();
  });
}

function idToUrl(id) {
  if ('channelId' in id) return `https://www.youtube.com/channel/${id.channelId}/live`;
  if ('liveId'    in id) return `https://www.youtube.com/watch?v=${id.liveId}`;
  if ('handle'    in id) {
    const h = id.handle.startsWith('@') ? id.handle : `@${id.handle}`;
    return `https://www.youtube.com/${h}/live`;
  }
  throw new TypeError('Required channelId, liveId, or handle');
}

function parsePage(html) {
  const liveMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([^"]+)"/);
  if (!liveMatch) throw new Error('Live stream not found');

  if (/['"]isReplay['"]:\s*true/.test(html)) throw new Error(`${liveMatch[1]} is a finished live stream`);

  const keyMatch  = html.match(/['"]INNERTUBE_API_KEY['"]:\s*['"]([^'"]+)['"]/);
  const verMatch  = html.match(/['"]clientVersion['"]:\s*['"]([\d.]+)['"]/);
  const contMatch = html.match(/['"]continuation['"]:\s*['"]([^'"]+)['"]/);

  if (!keyMatch)  throw new Error('API key not found');
  if (!verMatch)  throw new Error('Client version not found');
  if (!contMatch) throw new Error('Continuation not found');

  return { liveId: liveMatch[1], apiKey: keyMatch[1], clientVersion: verMatch[1], continuation: contMatch[1] };
}

function parseThumbnail(thumbnails, alt) {
  const t = thumbnails?.[thumbnails.length - 1];
  return t ? { url: t.url, alt: alt || '' } : { url: '', alt: '' };
}

function parseMessageRuns(runs) {
  return (runs || []).map(run => {
    if ('text' in run) return run;
    const emoji = run.emoji;
    const thumb = emoji?.image?.thumbnails?.[0];
    const isCustom = Boolean(emoji?.isCustomEmoji);
    const shortcut = emoji?.shortcuts?.[0] || '';
    return { url: thumb?.url || '', alt: shortcut, isCustomEmoji: isCustom, emojiText: isCustom ? shortcut : (emoji?.emojiId || '') };
  });
}

function parseRenderer(renderer) {
  const authorName = renderer.authorName?.simpleText || '';
  const item = {
    id:           renderer.id,
    author: {
      name:      authorName,
      thumbnail: parseThumbnail(renderer.authorPhoto?.thumbnails, authorName),
      channelId: renderer.authorExternalChannelId || '',
    },
    message:      parseMessageRuns(renderer.message?.runs ?? renderer.headerSubtext?.runs),
    isMembership: false,
    isOwner:      false,
    isVerified:   false,
    isModerator:  false,
    timestamp:    new Date(Number(renderer.timestampUsec) / 1000),
  };

  for (const entry of renderer.authorBadges || []) {
    const badge = entry.liveChatAuthorBadgeRenderer;
    if (badge?.customThumbnail) {
      item.author.badge = { thumbnail: parseThumbnail(badge.customThumbnail.thumbnails, badge.tooltip), label: badge.tooltip || '' };
      item.isMembership = true;
    } else {
      switch (badge?.icon?.iconType) {
        case 'OWNER':     item.isOwner = true;     break;
        case 'VERIFIED':  item.isVerified = true;  break;
        case 'MODERATOR': item.isModerator = true; break;
      }
    }
  }

  if ('sticker' in renderer) {
    item.superchat = {
      amount:  renderer.purchaseAmountText?.simpleText || '',
      color:   `#${(renderer.backgroundColor ?? 0).toString(16).slice(-6).toUpperCase()}`,
      sticker: parseThumbnail(renderer.sticker?.thumbnails, renderer.sticker?.accessibility?.accessibilityData?.label),
    };
  } else if ('purchaseAmountText' in renderer) {
    item.superchat = {
      amount: renderer.purchaseAmountText?.simpleText || '',
      color:  `#${(renderer.bodyBackgroundColor ?? 0).toString(16).slice(-6).toUpperCase()}`,
    };
  }

  return item;
}

function parseActions(actions) {
  const chatItems = [];
  const deletedIds = [];

  for (const action of actions) {
    if (action.addChatItemAction) {
      const item = action.addChatItemAction.item;
      const renderer =
        item.liveChatTextMessageRenderer   ||
        item.liveChatPaidMessageRenderer   ||
        item.liveChatPaidStickerRenderer   ||
        item.liveChatMembershipItemRenderer;
      if (renderer) {
        try { chatItems.push(parseRenderer(renderer)); } catch { /* skip malformed */ }
      }
    } else if (action.removeChatItemAction) {
      const id = action.removeChatItemAction.targetItemId;
      if (id) deletedIds.push(id);
    }
  }

  return { chatItems, deletedIds };
}

function parseChatData(data) {
  const lcc = data?.continuationContents?.liveChatContinuation;
  if (!lcc) throw new Error('Unexpected response structure');

  const { chatItems, deletedIds } = parseActions(lcc.actions || []);

  const contData = lcc.continuations?.[0];
  const continuation =
    contData?.invalidationContinuationData?.continuation ||
    contData?.timedContinuationData?.continuation        ||
    '';

  return { chatItems, deletedIds, continuation };
}

export class LiveChat extends EventEmitter {
  liveId;
  #id;
  #interval;
  #options = null;
  #timer = null;

  constructor(id, interval = 1000) {
    super();
    if (!id || (!('channelId' in id) && !('liveId' in id) && !('handle' in id))) {
      throw new TypeError('Required channelId, liveId, or handle');
    }
    if ('liveId' in id) this.liveId = id.liveId;
    this.#id = id;
    this.#interval = interval;
  }

  async start() {
    if (this.#timer) return false;
    try {
      const html = await fetchText(idToUrl(this.#id));
      this.#options = parsePage(html);
      this.liveId = this.#options.liveId;
      this.#timer = setInterval(() => this.#execute(), this.#interval);
      this.emit('start', this.liveId);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  stop(reason) {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
      this.emit('end', reason);
    }
  }

  async #execute() {
    if (!this.#options) return;
    try {
      const url = `https://www.youtube.com/youtubei/v1/live_chat/get_live_chat?key=${this.#options.apiKey}`;
      const res = await postJson(url, {
        context: { client: { clientVersion: this.#options.clientVersion, clientName: 'WEB' } },
        continuation: this.#options.continuation,
      });
      const { chatItems, deletedIds, continuation } = parseChatData(res);
      this.#options.continuation = continuation;
      chatItems.forEach(item => this.emit('chat', item));
      deletedIds.forEach(id => this.emit('delete', id));
    } catch (err) {
      this.emit('error', err);
    }
  }
}
