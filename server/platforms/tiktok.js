// TikTok LIVE chat via the community `tiktok-live-connector` package.
//
// TikTok has no public/official API for reading LIVE chat anonymously —
// this library reverse-engineers their internal "webcast" WebSocket
// protocol. That protocol changes periodically on TikTok's end.
//
// IMPORTANT — this is the most likely piece to need adjustment over time:
// if TikTok chat stops connecting, first try `npm update tiktok-live-connector`.
// If it still fails after that, check that package's own README/changelog —
// its exported class name and event payload shapes (`chat`, `roomUser`, etc.)
// have changed across major versions before, and the two `.on(...)` blocks
// below are the only places that would need to change to match.
import { EventEmitter } from 'events';
import { WebcastPushConnection } from 'tiktok-live-connector';

export class TikTokChat extends EventEmitter {
  #username;
  #conn = null;

  constructor(username) {
    super();
    this.#username = String(username).replace(/^@/, '').trim();
  }

  async start() {
    try {
      this.#conn = new WebcastPushConnection(this.#username);

      this.#conn.on('chat', (data) => {
        this.emit('chat', {
          id: data.msgId != null ? String(data.msgId) : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          author: {
            name: data.nickname || data.uniqueId || 'Anonymous',
            thumbnail: { url: data.profilePictureUrl || '', alt: data.nickname || '' },
            channelId: data.uniqueId || '',
          },
          message: [{ text: data.comment || '' }],
          isMembership: Boolean(data.isSubscriber),
          isOwner: Boolean(data.uniqueId && data.uniqueId === this.#username),
          isVerified: false,
          isModerator: Boolean(data.isModerator),
          timestamp: new Date(),
        });
      });

      this.#conn.on('roomUser', (data) => {
        if (typeof data?.viewerCount === 'number') this.emit('viewerCount', data.viewerCount);
      });

      this.#conn.on('streamEnd', () => this.emit('end', 'stream ended'));
      this.#conn.on('disconnected', () => this.emit('end', 'disconnected'));
      this.#conn.on('error', (err) => this.emit('error', err));

      await this.#conn.connect();
      this.emit('start', this.#username);
      return true;
    } catch (err) {
      this.emit('error', err);
      return false;
    }
  }

  stop() {
    if (this.#conn) {
      try { this.#conn.disconnect(); } catch { /* already gone */ }
      this.#conn = null;
    }
  }
}
