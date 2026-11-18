/*
 * ONE DOCUMENT.
 *
 * Everything the Hub knows - members, games, house edits, settings, bans, tombstones,
 * the activity log - lives in a single KV value called `state`. Cover pictures, the
 * signing key and the few rate counters stay in their own keys.
 *
 * Why: KV's free plan caps list operations at about a thousand a day, and the old
 * shape ran three list() calls on every single page view. Now a page view is one read
 * and nothing else, and no request path calls list() at all.
 *
 * Writes are read-modify-write of that one document: update() re-reads immediately
 * before it writes, so a change made while something slow (the refresh) was running is
 * merged in rather than trampled.
 */

export const STATE_KEY = 'state';
export const STATE_V = 4;

export function emptyState() {
  return {
    v: STATE_V,
    members: {},
    games: {},
    house: {},
    bans: {},
    tombs: {},
    settings: null
  };
}

function asObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

export function normalizeState(raw) {
  const s = asObject(raw);
  return {
    v: STATE_V,
    members: asObject(s.members),
    games: asObject(s.games),
    house: asObject(s.house),
    bans: asObject(s.bans),
    tombs: asObject(s.tombs),
    settings: s.settings && typeof s.settings === 'object' ? s.settings : null
  };
}

/*
 * The one-time move from the old key-per-record shape. It runs on the first request
 * after the new code is deployed, is idempotent (it only runs when `state` is missing),
 * and leaves every old key exactly where it is, so nothing is lost if it has to be
 * looked at again by hand.
 */
export async function migrateFromKeys(store) {
  const s = emptyState();
  const grab = async (prefix, into, keyOf) => {
    let rows = [];
    try {
      rows = await store.list(prefix);
    } catch (e) {
      rows = [];
    }
    for (const r of rows) {
      if (!r || !r.value) continue;
      const k = keyOf(r);
      if (k) into[k] = r.value;
    }
  };
  await grab('member:', s.members, (r) => String(r.value.id || r.key.slice(7)));
  await grab('game:', s.games, (r) => r.key.slice(5));
  await grab('house:', s.house, (r) => r.key.slice(6));
  await grab('ban:', s.bans, (r) => String(r.value.id || r.key.slice(4)));
  await grab('tomb:', s.tombs, (r) => r.key.slice(5));
  try {
    const settings = await store.get('settings');
    if (settings && typeof settings === 'object') s.settings = settings;
  } catch (e) {
    /* no settings yet */
  }
  await store.put(STATE_KEY, s);
  return s;
}

export async function getState(store) {
  const raw = await store.get(STATE_KEY);
  if (raw) return normalizeState(raw);
  return normalizeState(await migrateFromKeys(store));
}

/*
 * Read, change, write. `fn` gets the freshest copy and may return a value for the
 * caller; set `skip` on the returned box to walk away without writing.
 *
 * A store may carry a `sweep` function (the Worker hangs one on it in index.js). It
 * runs on the fresh document before every change, which is how records that must not
 * exist at all - the Hub's own repo - are cleared out without a job of their own. When
 * the sweep found something, the document is written even if the change itself asked
 * not to be.
 */
export async function update(store, fn) {
  const state = await getState(store);
  let swept = false;
  if (store && typeof store.sweep === 'function') {
    swept = Boolean(await store.sweep(state, store));
  }
  const out = await fn(state);
  if (out && out.__noWrite) {
    if (!swept) return out.result;
    await store.put(STATE_KEY, state);
    return out.result;
  }
  await store.put(STATE_KEY, state);
  return out;
}

export function noWrite(result) {
  return { __noWrite: true, result: result };
}

/* ---------- small accessors, so the rest of the code reads nicely ---------- */

export function gameId(ownerId, repo) {
  return Number(ownerId) + '/' + repo;
}

export function listOf(map) {
  return Object.keys(map || {}).map((k) => map[k]).filter(Boolean);
}
