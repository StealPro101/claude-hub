/*
 * One tiny storage interface: get / put / delete / list.
 * Cloudflare KV in production, a Map in tests, a JSON file in local runs
 * (tools/file-store.js) - the Worker code never knows which.
 *
 * Keys:
 *   member:<id>              a friend on the Hub
 *   game:<ownerId>/<repo>    a game
 *   tomb:<ownerId>/<repo>    removed on purpose, do not auto-add again
 *   ban:<id>                 cannot sign in
 *   settings                 round, invite, activity log
 *   secret:session           the signing key the Worker made for itself
 *
 * list() never returns a secret:* key, whatever prefix is asked for, so nothing that
 * walks the store can carry the signing key into an API answer or a log line.
 */

const HIDDEN = 'secret:';

function visible(key) {
  return !String(key).startsWith(HIDDEN);
}

export function kvStore(kv) {
  return {
    async get(key) {
      return kv.get(key, 'json');
    },
    async put(key, value) {
      await kv.put(key, JSON.stringify(value));
    },
    async delete(key) {
      await kv.delete(key);
    },
    async list(prefix) {
      const out = [];
      let cursor;
      for (let page = 0; page < 20; page++) {
        const res = await kv.list({ prefix: prefix, cursor: cursor });
        const names = (res.keys || []).map((k) => k.name).filter(visible);
        const values = await Promise.all(names.map((n) => kv.get(n, 'json')));
        for (let i = 0; i < names.length; i++) {
          if (values[i] != null) out.push({ key: names[i], value: values[i] });
        }
        if (res.list_complete || !res.cursor) break;
        cursor = res.cursor;
      }
      return out;
    }
  };
}

export function memoryStore(initial) {
  const map = new Map();
  if (initial) for (const [k, v] of Object.entries(initial)) map.set(k, JSON.stringify(v));
  return {
    _map: map,
    async get(key) {
      const raw = map.get(key);
      return raw == null ? null : JSON.parse(raw);
    },
    async put(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list(prefix) {
      const out = [];
      for (const [k, raw] of map) {
        if (k.startsWith(prefix) && visible(k)) out.push({ key: k, value: JSON.parse(raw) });
      }
      out.sort((a, b) => a.key.localeCompare(b.key));
      return out;
    }
  };
}

/* Writes only when the stored value really changed (KV free tier is ~1000/day). */
export async function putIfChanged(store, key, value) {
  const before = await store.get(key);
  if (before && JSON.stringify(before) === JSON.stringify(value)) return false;
  await store.put(key, value);
  return true;
}
