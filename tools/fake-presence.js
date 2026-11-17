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
  return {
    core: core,
    idFromName() { return 'hub'; },
    get() { return stub; },
    break(on) { o.broken = on !== false; }
  };
}
