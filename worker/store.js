/*
 * One tiny storage interface: get / put / delete / list, plus putBytes / getBytes for
 * the one binary thing the Hub keeps - a game's cover picture.
 * Cloudflare KV in production, a Map in tests, a JSON file in local runs
 * (tools/file-store.js) - the Worker code never knows which.
 *
 * Keys:
 *   member:<id>              a friend on the Hub
 *   game:<ownerId>/<repo>    a game
 *   tomb:<ownerId>/<repo>    removed on purpose, do not auto-add again
 *   ban:<id>                 cannot sign in
 *   house:<slug>             the owner's edits to a house game
 *   rate:<what>:<who>        a counter the isolate cannot be trusted to keep
 *   settings                 round, invite, activity log
 *   secret:session           the signing key the Worker made for itself
 *   cover:<owner>/<repo>     cover picture bytes (owner is a numeric id or "house")
 *
 * list() never returns a secret:* or cover:* key, whatever prefix is asked for, so
 * nothing that walks the store can drag the signing key or a pile of image bytes into
 * an API answer or a log line.
 */

const HIDDEN = ['secret:', 'cover:'];

function visible(key) {
  const k = String(key);
  for (const p of HIDDEN) if (k.startsWith(p)) return false;
  return true;
}

function b64FromBytes(bytes) {
  let s = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function bytesFromB64(b64) {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
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
    async putBytes(key, bytes, type) {
      await kv.put(key, bytes, { metadata: { type: type } });
    },
    async getBytes(key) {
      const res = await kv.getWithMetadata(key, 'arrayBuffer');
      if (!res || !res.value) return null;
      return {
        bytes: new Uint8Array(res.value),
        type: (res.metadata && res.metadata.type) || 'application/octet-stream'
      };
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
  const blobs = new Map();
  if (initial) for (const [k, v] of Object.entries(initial)) map.set(k, JSON.stringify(v));
  return {
    _map: map,
    _blobs: blobs,
    async get(key) {
      const raw = map.get(key);
      return raw == null ? null : JSON.parse(raw);
    },
    async put(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async delete(key) {
      map.delete(key);
      blobs.delete(key);
    },
    async putBytes(key, bytes, type) {
      blobs.set(key, { bytes: new Uint8Array(bytes), type: type });
    },
    async getBytes(key) {
      const row = blobs.get(key);
      return row ? { bytes: new Uint8Array(row.bytes), type: row.type } : null;
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

export { b64FromBytes, bytesFromB64 };
