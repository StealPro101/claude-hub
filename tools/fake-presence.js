/*
 * The Durable Object, in process. Same interface the Worker uses on Cloudflare
 * (idFromName -> get -> fetch), so the dev server and the tests exercise the real
 * PresenceCore without any Cloudflare runtime.
 */
import { PresenceCore } from '../worker/presence.js';

export function fakeStorage() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? JSON.parse(map.get(key)) : undefined; },
    async put(key, value) { map.set(key, JSON.stringify(value)); },
    async delete(key) { map.delete(key); },
    _map: map
  };
}

/*
 * A stand-in for one socket on the object: the two calls the hibernation API gives
 * (serializeAttachment / deserializeAttachment), send, close and readyState. Everything
 * it was told is kept so a test can read it back.
 */
export function fakeSocket(label) {
  return {
    label: label || 'ws',
    sent: [],
    closed: null,
    readyState: 1,
    tags: [],
    att: null,
    send(line) {
      if (this.readyState !== 1) throw new Error('that socket is closed');
      this.sent.push(String(line));
    },
    close(code, reason) {
      this.readyState = 3;
      if (!this.closed) this.closed = { code: code, reason: reason };
    },
    serializeAttachment(value) {
      this.att = JSON.parse(JSON.stringify(value));
    },
    deserializeAttachment() {
      return this.att === null ? null : JSON.parse(JSON.stringify(this.att));
    },
    /* what it was told, parsed */
    got() {
      return this.sent.map((line) => JSON.parse(line));
    },
    ofType(t) {
      return this.got().filter((m) => m.t === t);
    },
    last() {
      const all = this.got();
      return all.length ? all[all.length - 1] : null;
    }
  };
}

/*
 * The object's socket side: acceptWebSocket and getWebSockets, kept in one registry so
 * a brand new RoomsCore can be pointed at the very same sockets - which is what a wake
 * from sleep really is. A closed socket stays in the registry on purpose, because the
 * core must not count it as being in the room any more.
 */
export function fakeRoomState() {
  const list = [];
  return {
    list: list,
    accept(ws, tags) {
      ws.tags = (tags || []).slice();
      if (list.indexOf(ws) < 0) list.push(ws);
    },
    sockets(tag) {
      return tag === undefined ? list.slice() : list.filter((ws) => ws.tags.indexOf(tag) >= 0);
    },
    /* the two ops a RoomsCore is built with */
    ops(storage, clock) {
      return {
        storage: storage,
        now: clock,
        accept: (ws, tags) => this.accept(ws, tags),
        sockets: (tag) => this.sockets(tag)
      };
    }
  };
}

/* `clock` lets a test move time forward: fakePresence({ clock: () => fakeNow }) */
export function fakePresence(opts) {
  const o = opts || {};
  const core = new PresenceCore(o.storage || fakeStorage(), o.clock || (() => Date.now()));
  const stub = {
    core: core,
    async fetch(url, init) {
      let body = {};
      try {
        body = JSON.parse((init && init.body) || '{}');
      } catch (e) {
        body = {};
      }
      if (o.broken) throw new Error('presence is having a bad day');
      const out = await core.handle(body);
      return new Response(JSON.stringify(out || { ok: false }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
  /*
   * The "rooms" instance. Node cannot build a 101 response, so this answers an upgrade
   * with a plain 200 that repeats what the Worker forwarded - which is the thing a test
   * of the Worker's side wants to see anyway: the finished room key, id and name, and
   * nothing raw from the client. On Cloudflare the real object answers 101 instead and
   * the Worker hands that straight back, untouched.
   */
  const roomsStub = {
    seen: [],
    async fetch(url, init) {
      const headers = new Headers((init && init.headers) || (url && url.headers) || {});
      const href = typeof url === 'string' ? url : url.url;
      if ((headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
        const u = new URL(href);
        const asked = {
          upgrade: true,
          room: u.searchParams.get('room'),
          pid: u.searchParams.get('pid'),
          name: u.searchParams.get('name'),
          raw: u.search
        };
        roomsStub.seen.push(asked);
        return new Response(JSON.stringify(asked), {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      }
      return stub.fetch(url, init);
    }
  };

  return {
    core: core,
    rooms: roomsStub,
    idFromName(name) { return name === 'rooms' ? 'rooms' : 'hub'; },
    get(id) { return id === 'rooms' ? roomsStub : stub; },
    break(on) { o.broken = on !== false; }
  };
}
