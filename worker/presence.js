/*
 * Who is here, who is playing what, how many times a game has been opened, and how long
 * it has been played - by everybody together, and by each member on their own.
 *
 * All of this changes every few seconds, which is exactly what KV is bad at (the free
 * plan allows about a thousand writes a day). So it lives in one Durable Object
 * instead: the live part in memory, and only the counters - visits, recently played and
 * play time - in its storage, written at most once a minute and only where something
 * changed.
 *
 * PresenceCore is the logic on its own, with the clock and the storage passed in, so it
 * can be driven straight from a test or from an in-process fake in local runs.
 */

const GONE_AFTER = 90000;       /* no beat for 90s = gone */
const VISIT_WINDOW = 30 * 60000; /* one visit per person per game per half hour */
const SAVE_EVERY = 60000;       /* visit counters reach storage at most once a minute */
const MAX_WATCHED = 5000;
const MAX_RECENT = 12;          /* how many games one member's "recently played" keeps */
const MAX_TIMED = 500;          /* how many games one member's own play time keeps */

export class PresenceCore {
  constructor(storage, now) {
    this.storage = storage || null;
    this.now = now || (() => Date.now());
    this.members = new Map();   /* memberId -> { at, game } */
    this.guests = new Map();    /* token -> { at, game } */
    this.visits = new Map();    /* gameId -> count */
    this.recent = new Map();    /* memberId -> [gameId, ...] newest first, their eyes only */
    this.time = new Map();      /* gameId -> ms played by everybody together */
    this.myTime = new Map();    /* memberId -> Map(gameId -> ms), their eyes only */
    this.seenVisit = new Map(); /* who|game -> at */
    this.rates = new Map();     /* key -> { start, n } */
    this.loaded = false;
    /* one flag per storage key, so an idle minute writes nothing at all */
    this.dirtyVisits = false;
    this.dirtyRecent = false;
    this.dirtyTime = false;
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
      /* Play time, in milliseconds: { total: { game: ms }, by: { member: { game: ms } } }.
         It is ADDED to what is in memory, not put in its place, so a beat that arrived
         while this object was still waking up is kept rather than thrown away. */
      const spent = await this.storage.get('time');
      if (spent && typeof spent === 'object') {
        const total = spent.total && typeof spent.total === 'object' ? spent.total : {};
        for (const [k, v] of Object.entries(total)) {
          if (Number.isFinite(v) && v > 0) this.time.set(k, (this.time.get(k) || 0) + Number(v));
        }
        const by = spent.by && typeof spent.by === 'object' ? spent.by : {};
        for (const [who, games] of Object.entries(by)) {
          if (!games || typeof games !== 'object') continue;
          if (!this.myTime.has(who) && this.myTime.size >= MAX_WATCHED) continue;
          const theirs = this.myTime.get(who) || new Map();
          for (const [game, v] of Object.entries(games)) {
            if (!Number.isFinite(v) || v <= 0) continue;
            if (!theirs.has(game) && theirs.size >= MAX_TIMED) continue;
            theirs.set(game, (theirs.get(game) || 0) + Number(v));
          }
          if (theirs.size) this.myTime.set(who, theirs);
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

  /*
   * How long somebody has played: measured from the beats that are already coming in,
   * never from a clock the page could lie about.
   *
   * `prev` is the row this identity had before the beat that is being handled. If it
   * said "in this game", the stretch between then and now is play time - as long as it
   * is short enough to be one unbroken stretch. A gap over GONE_AFTER means the tab was
   * hidden or gone, and counts for nothing.
   *
   * `creditTo` is the member whose own total this belongs to, or null for a guest: a
   * guest adds to the game's total and to nobody's own time, because there is nobody to
   * credit. Returns the milliseconds credited.
   */
  credit(prev, creditTo, at) {
    if (!prev || !prev.game) return 0;
    const span = at - prev.at;
    if (!(span > 0) || span > GONE_AFTER) return 0;
    this.time.set(prev.game, (this.time.get(prev.game) || 0) + span);
    const who = creditTo == null ? '' : String(creditTo);
    if (who && who !== 'anon' && who.indexOf('ip:') !== 0) {
      let theirs = this.myTime.get(who);
      if (!theirs && this.myTime.size < MAX_WATCHED) {
        theirs = new Map();
        this.myTime.set(who, theirs);
      }
      if (theirs && (theirs.has(prev.game) || theirs.size < MAX_TIMED)) {
        theirs.set(prev.game, (theirs.get(prev.game) || 0) + span);
      }
    }
    this.dirtyTime = true;
    return span;
  }

  /* One heartbeat. A signed-in member is known by id; everyone else is a random
     per-tab token, counted but never named.

     `creditTo` is the signed-in member's id even when their presence is hidden - they
     are beaten as a guest then, but their own play time is still theirs. */
  beat(who, token, game, creditTo) {
    const at = this.now();
    const key = who ? String(who) : null;
    /* the row this beat is about to replace is what says how long they have been in
       there; two tabs of one member share one row, so wall-clock time is never doubled */
    const prev = key ? this.members.get(key) : (token ? this.guests.get(token) : null);
    const had = prev && prev.game ? prev.game : null;
    this.credit(prev, creditTo != null ? creditTo : key, at);
    const row = { at: at, game: game || null };
    if (key) this.members.set(key, row);
    else if (token) {
      if (this.guests.size < MAX_WATCHED || this.guests.has(token)) this.guests.set(token, row);
    }
    this.sweep();
    /* a play session that just ended is worth one write; an idle minute is not */
    return this.maybeSave(Boolean(had) && had !== row.game).then(() => ({ ok: true }));
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
    const at = this.now();
    /* this rewrites `at`, so whatever time that row was owed has to be credited first */
    this.credit(row, key, at);
    this.members.set(key, { at: at, game: row ? row.game : null });
    return { ok: true };
  }

  /* The way out. The tail of the stretch counts too, before the row goes. */
  leave(who, token, creditTo) {
    const key = who ? String(who) : null;
    const prev = key ? this.members.get(key) : (token ? this.guests.get(token) : null);
    const credited = this.credit(prev, creditTo != null ? creditTo : key, this.now());
    if (key) this.members.delete(key);
    if (token) this.guests.delete(token);
    return this.maybeSave(credited > 0).then(() => ({ ok: true }));
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
    this.dirtyRecent = true;
  }

  forget(who) {
    const key = String(who || '');
    if (key && this.recent.delete(key)) this.dirtyRecent = true;
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
    this.dirtyVisits = true;
    await this.maybeSave();
    return { ok: true, counted: true };
  }

  /*
   * Only the keys that really changed are written, so a minute in which nobody played
   * costs nothing and a minute of playing costs one put.
   */
  async maybeSave(force) {
    if (!this.storage) return;
    if (!this.dirtyVisits && !this.dirtyRecent && !this.dirtyTime) return;
    const at = this.now();
    if (!force && at - this.savedAt < SAVE_EVERY) return;
    /* never write before reading: a cold object would otherwise put its handful of
       seconds where everything counted so far used to be */
    await this.load();
    this.savedAt = at;
    const jobs = [];
    if (this.dirtyVisits) {
      const out = {};
      for (const [k, v] of this.visits) out[k] = v;
      jobs.push(['visits', out, 'dirtyVisits']);
    }
    if (this.dirtyRecent) {
      const mine = {};
      for (const [k, v] of this.recent) mine[k] = v;
      jobs.push(['recent', mine, 'dirtyRecent']);
    }
    if (this.dirtyTime) {
      const total = {};
      for (const [k, v] of this.time) total[k] = v;
      const by = {};
      for (const [k, games] of this.myTime) {
        const one = {};
        for (const [g, v] of games) one[g] = v;
        by[k] = one;
      }
      jobs.push(['time', { total: total, by: by }, 'dirtyTime']);
    }
    for (const [key, value, flag] of jobs) {
      try {
        await this.storage.put(key, value);
        this[flag] = false;
      } catch (e) {
        /* it stays dirty and is tried again at the next save */
      }
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
    /* how long everybody together has played each game: public, a number about a game */
    const time = {};
    for (const [k, v] of this.time) time[k] = v;
    /* and how long THIS person has, which is theirs alone and nobody else's */
    const myTime = {};
    const theirs = recentFor ? this.myTime.get(String(recentFor)) : null;
    if (theirs) for (const [k, v] of theirs) myTime[k] = v;
    return {
      at: this.now(), active: active, members: members, visits: visits, recent: recent,
      time: time, myTime: myTime
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
    if (cmd === 'beat') return this.beat(body.who, body.token, body.game, body.creditTo);
    if (cmd === 'leave') return this.leave(body.who, body.token, body.creditTo);
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
  const EMPTY = {
    at: Date.now(), active: {}, members: {}, visits: {}, recent: [], time: {}, myTime: {}
  };

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
    /* creditTo: whose own play time this beat belongs to, hidden presence and all */
    async beat(who, token, game, creditTo) {
      return (await call({
        cmd: 'beat', who: who, token: token, game: game, creditTo: creditTo || null
      })) || { ok: true };
    },
    async leave(who, token, creditTo) {
      return (await call({
        cmd: 'leave', who: who, token: token, creditTo: creditTo || null
      })) || { ok: true };
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
