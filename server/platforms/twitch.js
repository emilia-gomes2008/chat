// Anonymous read-only Twitch chat client over IRC-over-WebSocket.
// Twitch allows anonymous logins ("justinfan#####") for *reading* chat —
// no OAuth token or registered app needed. This is the same trick most
// open-source Twitch chat overlays use.
//
// NOT included here: a viewer-count source for Twitch. Unlike YouTube's
// watch page (which server-renders a viewer count into the HTML) and
// TikTok's webcast connection (which reports it for free), Twitch's page
// is a client-rendered SPA that doesn't expose it without either an
// authenticated Helix API call (needs a free registered Twitch app: a
// Client ID + Client Secret) or a fragile GQL scrape. Twitch chat still
// works fully without this — it just won't contribute to the combined
// viewer counter. Ask if you want the Helix version added; it just needs
// two config values.
import { EventEmitter } from 'events';
import WebSocket from 'ws';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

function parseTagString(raw) {
  const tags = {};
  if (!raw) return tags;
  for (const pair of raw.slice(1).split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    tags[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return tags;
}

function unescapeTagValue(v = '') {
  return v
    .replace(/\\s/g, ' ')
    .replace(/\\:/g, ';')
    .replace(/\\r/g, '\r')
    .replace(/\\n/g, '\n')
    .replace(/\\\\/g, '\\');
}

function parseIrcLine(line) {
  let rest = line;
  let tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    tags = parseTagString(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  let prefix = '';
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  const trailingIdx = rest.indexOf(' :');
  let command, params;
  if (trailingIdx === -1) {
    [command, ...params] = rest.split(' ');
  } else {
    const head = rest.slice(0, trailingIdx).split(' ');
    command = head[0];
    params = [...head.slice(1), rest.slice(trailingIdx + 2)];
  }
  return { tags, prefix, command, params };
}

export class TwitchChat extends EventEmitter {
  #channel;
  #ws = null;
  #pingTimer = null;
  #started = false;

  constructor(channel) {
    super();
    this.#channel = String(channel).replace(/^#/, '').trim().toLowerCase();
  }

  start() {
    if (this.#ws) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (ok) => { if (!settled) { settled = true; resolve(ok); } };

      try {
        const ws = new WebSocket(IRC_URL);
        this.#ws = ws;

        ws.on('open', () => {
          const nick = `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
          ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
          ws.send(`NICK ${nick}`);
          ws.send(`JOIN #${this.#channel}`);
        });

        ws.on('message', (data) => {
          const lines = data.toString('utf-8').split('\r\n').filter(Boolean);
          for (const line of lines) this.#handleLine(line, ws, settle);
        });

        ws.on('close', () => {
          this.#cleanup();
          this.emit('end', 'closed');
          settle(false);
        });

        ws.on('error', (err) => {
          this.emit('error', err);
          settle(false);
        });
      } catch (err) {
        this.emit('error', err);
        settle(false);
      }
    });
  }

  #handleLine(line, ws, settle) {
    const { tags, prefix, command, params } = parseIrcLine(line);

    if (command === 'PING') {
      ws.send(`PONG :${params[0] || 'tmi.twitch.tv'}`);
      return;
    }

    if (command === '001' && !this.#started) {
      this.#started = true;
      this.#pingTimer = setInterval(() => { try { ws.send('PING :keepalive'); } catch { /* closing */ } }, 4 * 60_000);
      this.emit('start', this.#channel);
      settle(true);
      return;
    }

    if (command === 'NOTICE' && /login authentication failed|improperly formatted auth/i.test(params[1] || '')) {
      this.emit('error', new Error(`Twitch IRC rejected connection: ${params[1]}`));
      settle(false);
      return;
    }

    if (command === 'PRIVMSG') {
      const text = params[1] || '';
      const displayName = unescapeTagValue(tags['display-name']) || prefix.split('!')[0] || 'Anonymous';
      const badges = (tags.badges || '').split(',').filter(Boolean).map(b => b.split('/')[0]);
      const isOwner = badges.includes('broadcaster');
      const isModerator = badges.includes('moderator') || isOwner;
      const isMembership = badges.includes('subscriber') || badges.includes('founder');

      this.emit('chat', {
        id: tags.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        author: {
          name: displayName,
          thumbnail: { url: '', alt: displayName },
          channelId: tags['user-id'] || '',
        },
        message: [{ text: unescapeTagValue(text) }],
        isMembership,
        isOwner,
        isVerified: false,
        isModerator,
        timestamp: tags['tmi-sent-ts'] ? new Date(Number(tags['tmi-sent-ts'])) : new Date(),
      });
      return;
    }

    if (command === 'CLEARMSG' && tags['target-msg-id']) {
      this.emit('delete', tags['target-msg-id']);
    }
  }

  #cleanup() {
    if (this.#pingTimer) { clearInterval(this.#pingTimer); this.#pingTimer = null; }
    this.#started = false;
  }

  stop() {
    this.#cleanup();
    if (this.#ws) {
      try { this.#ws.removeAllListeners('close'); this.#ws.close(); } catch { /* already closed */ }
      this.#ws = null;
    }
  }
}
