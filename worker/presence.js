/*
 * Who is here, who is playing what, and how many times a game has been opened.
 *
 * All of this changes every few seconds, which is exactly what KV is bad at (the free
 * plan allows about a thousand writes a day). So it lives in one Durable Object
 * instead: the live part in memory, and only the visit counters in its storage, written
 * at most once a minute.
 *
 * PresenceCore is the logic on its own, with the clock and the storage passed in, so it
 * can be driven straight from a test or from an in-process fake in local runs.
 */

const GONE_AFTER = 90000;       /* no beat for 90s = gone */
const VISIT_WINDOW = 30 * 60000; /* one visit per person per game per half hour */
const SAVE_EVERY = 60000;       /* visit counters reach storage at most once a minute */
const MAX_WATCHED = 5000;
const MAX_RECENT = 12;          /* how many games one member's "recently played" keeps */

export class PresenceCore {
  constructor(storage, now) {
    this.storage = storage || null;
    this.now = now || (() => Date.now());
    this.members = new Map();   /* memberId -> { at, game } */
    this.guests = new Map();    /* token -> { at, game } */
    this.visits = new Map();    /* gameId -> count */
    this.recent = new Map();    /* memberId -> [gameId, ...] newest first, their eyes only */
    this.seenVisit = new Map(); /* who|game -> at */
    this.rates = new Map();     /* key -> { start, n } */
    this.loaded = false;
    this.dirty = false;
    this.savedAt = 0;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!this.storage) return;
      const saved = await this.storage.get('visits');
      if (saved && typeof saved === 'object') {
        for (const [k, v] of Object.entries(saved)) {
          if (Number.isFinite(v)) this.visits.set(k, Number(v));
        }
      }
      const mine = await this.storage.get('recent');
      if (mine && typeof mine === 'object') {
        for (const [k, v] of Object.entries(mine)) {
          if (Array.isArray(v)) {
            this.recent.set(k, v.filter((id) => typeof id === 'string').slice(0, MAX_RECENT));
          }
        }
      }
    } catch (e) {
      /* a fresh object, or storage having a bad day: start from nothing */
    }
  }

  sweep() {
    const cutoff = this.now() - GONE_AFTER;
    for (const [k, v] of this.members) if (v.at < cutoff) this.members.delete(k);
    for (const [k, v] of this.guests) if (v.at < cutoff) this.guests.delete(k);
    if (this.seenVisit.size > MAX_WATCHED) {
      const old = this.now() - VISIT_WINDOW;
      for (const [k, at] of this.seenVisit) if (at < old) this.seenVisit.delete(k);
    }
  }

  /* One heartbeat. A signed-in member is known by id; everyone else is a random
     per-tab token, counted but never named. */
  beat(who, token, game) {
    const at = this.now();
    const row = { at: at, game: game || null };
    if (who) this.members.set(String(who), row);
    else if (token) {
      if (this.guests.size < MAX_WATCHED || this.guests.has(token)) this.guests.set(token, row);
    }
    this.sweep();
    return { ok: true };
  }

  /*
   * Someone is on the site: keep them "here" without claiming they are in a game.
   * Loading any page counts, which is what stops a person flickering offline between
   * pages - the leave beacon fires on every navigation, not only when a tab closes.
   */
  touch(who) {
    if (!who) return { ok: true };
    const key = String(who);
    const row = this.members.get(key);
    this.members.set(key, { at: this.now(), game: row ? row.game : null });
    return { ok: true };
  }

  leave(who, token) {
    if (who) this.members.delete(String(who));
    if (token) this.guests.delete(token);
    return { ok: true };
  }

  /*
   * "Recently played", for one member, kept here and told to nobody else. A guest
   * (a token or an ip) is never remembered - there is nobody to remember.
   */
  remember(who, game) {
    const key = String(who || '');
    if (!key || key === 'anon' || key.indexOf('ip:') === 0) return;
    const had = this.recent.get(key);
    if (!had && this.recent.size >= MAX_WATCHED) return;
    const list = (had || []).filter((id) => id !== game);
    list.unshift(game);
    this.recent.set(key, list.slice(0, MAX_RECENT));
    this.dirty = true;
  }

  forget(who) {
    const key = String(who || '');
    if (key && this.recent.delete(key)) this.dirty = true;
    return this.maybeSave(true).then(() => ({ ok: true }));
  }

  async visit(game, who) {
    await this.load();
    if (!game) return { ok: false };
    const key = (who || 'anon') + '|' + game;
    const at = this.now();
    /* playing it again inside the half hour still brings it to the front */
    this.remember(who, game);
    const last = this.seenVisit.get(key);
    if (last && at - last < VISIT_WINDOW) {
      await this.maybeSave();
      return { ok: true, counted: false };
    }
    this.seenVisit.set(key, at);
    this.visits.set(game, (this.visits.get(game) || 0) + 1);
    this.dirty = true;
    await this.maybeSave();
    return { ok: true, counted: true };
  }

  async maybeSave(force) {
    if (!this.storage || !this.dirty) return;
    const at = this.now();
    if (!force && at - this.savedAt < SAVE_EVERY) return;
    this.savedAt = at;
    this.dirty = false;
    const out = {};
    for (const [k, v] of this.visits) out[k] = v;
    const mine = {};
    for (const [k, v] of this.recent) mine[k] = v;
    try {
      await this.storage.put('visits', out);
      await this.storage.put('recent', mine);
    } catch (e) {
      this.dirty = true;
    }
  }

  /*
   * Everything the site needs, in one answer. `recentFor` is one member id: their own
   * list comes back and nobody else's, ever. It is separate from `touch`, because
   * somebody who switched presence off still gets their own recently played.
   */
  async snapshot(recentFor) {
    await this.load();
    this.sweep();
    const active = {};
    const members = {};
    for (const [id, row] of this.members) {
      members[id] = { at: row.at, game: row.game || null };
      if (row.game) active[row.game] = (active[row.game] || 0) + 1;
    }
    for (const row of this.guests.values()) {
      if (row.game) active[row.game] = (active[row.game] || 0) + 1;
    }
    const visits = {};
    for (const [k, v] of this.visits) visits[k] = v;
    const recent = recentFor ? (this.recent.get(String(recentFor)) || []).slice() : [];
    return {
      at: this.now(), active: active, members: members, visits: visits, recent: recent
    };
  }

  /* A counter that would otherwise cost a KV write every time someone taps a heart. */
  rate(key, limit, windowMs) {
    const at = this.now();
    const row = this.rates.get(key);
    if (!row || at - row.start > windowMs) {
      this.rates.set(key, { start: at, n: 1 });
      if (this.rates.size > MAX_WATCHED) {
        for (const [k, v] of this.rates) if (at - v.start > windowMs) this.rates.delete(k);
      }
      return { ok: true, left: limit - 1 };
    }
    if (row.n >= limit) return { ok: false, left: 0 };
    row.n++;
    return { ok: true, left: limit - row.n };
  }

  async handle(body) {
    const cmd = body && body.cmd;
    if (cmd === 'beat') return this.beat(body.who, body.token, body.game);
    if (cmd === 'leave') return this.leave(body.who, body.token);
    if (cmd === 'visit') return this.visit(body.game, body.who);
    if (cmd === 'snapshot') {
      if (body.touch) this.touch(body.touch);
      return this.snapshot(body.recentFor);
    }
    if (cmd === 'touch') return this.touch(body.who);
    if (cmd === 'forget') return this.forget(body.who);
    if (cmd === 'rate') return this.rate(body.key, Number(body.limit), Number(body.windowMs));
    if (cmd === 'flush') return this.maybeSave(true);
    return { ok: false, error: 'no such presence command' };
  }
}

/*
 * The Worker's side of the conversation. Every call is wrapped: if the binding is
 * missing, the object is cold, or anything throws, the site carries on with no counts
 * and everybody offline. Presence is never worth an error page.
 */
export function presenceClient(env) {
  const binding = env && env.PRESENCE;
  const EMPTY = { at: Date.now(), active: {}, members: {}, visits: {}, recent: [] };

  async function call(body) {
    if (!binding) return null;
    try {
      const id = binding.idFromName('hub');
      const stub = binding.get(id);
      const res = await stub.fetch('https://presence.invalid/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  return {
    available: Boolean(binding),
    /* one round trip: "I am here", "who else is", and my own recently played */
    async snapshot(touchWho, recentFor) {
      return (await call({
        cmd: 'snapshot', touch: touchWho || null, recentFor: recentFor || null
      })) || EMPTY;
    },
    /* clearing one member's recently played; a dead object simply has nothing to clear */
    async forget(who) {
      return (await call({ cmd: 'forget', who: who })) || { ok: true };
    },
    async beat(who, token, game) {
      return (await call({ cmd: 'beat', who: who, token: token, game: game })) || { ok: true };
    },
    async leave(who, token) {
      return (await call({ cmd: 'leave', who: who, token: token })) || { ok: true };
    },
    async visit(game, who) {
      return (await call({ cmd: 'visit', game: game, who: who })) || { ok: true, counted: false };
    },
    /* null means "the object could not answer" - the caller then falls back to the store */
    async rate(key, limit, windowMs) {
      return call({ cmd: 'rate', key: key, limit: limit, windowMs: windowMs });
    }
  };
}

export const PRESENCE_GONE_AFTER = GONE_AFTER;
export const PRESENCE_VISIT_WINDOW = VISIT_WINDOW;
