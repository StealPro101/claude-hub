/*
 * Who is here, who is playing what, how many times a game has been opened, and how long
 * it has been played - by everybody together, and by each member on their own.
 *
 * All of this changes every few seconds, which is exactly what KV is bad at (the free
 * plan allows about a thousand writes a day). So it lives in one Durable Object
 * instead.
 *
 * Cloudflare puts an object like this to sleep after about ten quiet seconds, and its
 * memory goes with it. Beats come 45 seconds apart, so on a quiet evening every beat
 * meets a freshly woken object. Nothing here may therefore live in memory alone:
 * whatever a call changes is written before the call answers (only the keys that really
 * changed), and a woken object reads everything back before it does anything else.
 *
 * PresenceCore is the logic on its own, with the clock and the storage passed in, so it
 * can be driven straight from a test or from an in-process fake in local runs.
 *
 * A beat may also say WHICH SERVER of that game the player is in, so a friend's Join
 * lands them in the same one. It is kept on a MEMBER's row only - a guest is counted,
 * never named, so there is nobody to join - and only if it is really a public server id
 * (isPublicId); a private server's code is never sent here and would be refused if it
 * were. It is written through with the row like everything else, so it survives the
 * object going to sleep, and a beat without one clears it.
 */

import { isPublicId } from './rooms.js';

const GONE_AFTER = 90000;       /* no beat for 90s = gone */
const VISIT_WINDOW = 30 * 60000; /* one visit per person per game per half hour */
const TOUCH_EVERY = 15000;      /* a page load re-writes "I am here" at most this often */
const MAX_WATCHED = 5000;
const MAX_RECENT = 12;          /* how many games one member's "recently played" keeps */
const MAX_TIMED = 500;          /* how many games one member's own play time keeps */

export class PresenceCore {
  constructor(storage, now) {
    this.storage = storage || null;
    this.now = now || (() => Date.now());
    this.members = new Map();   /* memberId -> { at, game, server } */
    this.guests = new Map();    /* token -> { at, game } */
    this.visits = new Map();    /* gameId -> count */
    this.recent = new Map();    /* memberId -> [gameId, ...] newest first, their eyes only */
    this.time = new Map();      /* gameId -> ms played by everybody together */
    this.myTime = new Map();    /* memberId -> Map(gameId -> ms), their eyes only */
    this.seenVisit = new Map(); /* who|game -> at */
    this.rates = new Map();     /* key -> { start, n } */
    this.loaded = false;
    this.loading = null;
    this.ready = false;         /* storage has been read back; the maps can be trusted */
    /* one flag per storage key, so a call that changed nothing writes nothing */
    this.dirtyLive = false;
    this.dirtyVisits = false;
    this.dirtyRecent = false;
    this.dirtyTime = false;
    this.savedAt = 0;
  }

  /* One read, however many callers: everybody who asks while it is still under way
     waits for the same one, so nothing is ever written from a half-read object. */
  load() {
    if (!this.loading) this.loading = this.readStored();
    return this.loading;
  }

  async readStored() {
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
      /*
       * The live part - who is here, who is in which game, which visits were already
       * counted, the rate counters - as it stood when the object went to sleep. Rows
       * that have gone stale in the meantime are simply not read back.
       */
      const live = await this.storage.get('live');
      if (live && typeof live === 'object') {
        const at = this.now();
        const rows = (v) => (v && typeof v === 'object' ? Object.entries(v) : []);
        const fresh = (row) => Array.isArray(row) && Number.isFinite(row[0]) &&
          at - row[0] <= GONE_AFTER;
        for (const [k, row] of rows(live.m)) {
          if (fresh(row) && !this.members.has(k)) {
            /* row[2] is which server of that game they are in, when there is one: an
               older row simply has no third item, and anything that is not a public
               server id is read back as no server at all */
            this.members.set(k, {
              at: row[0],
              game: typeof row[1] === 'string' ? row[1] : null,
              server: row[1] && isPublicId(row[2]) ? row[2] : ''
            });
          }
        }
        for (const [k, row] of rows(live.g)) {
          if (fresh(row) && typeof row[1] === 'string' && !this.guests.has(k) &&
              this.guests.size < MAX_WATCHED) {
            this.guests.set(k, { at: row[0], game: row[1] });
          }
        }
        for (const [k, seen] of rows(live.v)) {
          if (Number.isFinite(seen) && at - seen < VISIT_WINDOW && !this.seenVisit.has(k)) {
            this.seenVisit.set(k, seen);
          }
        }
        for (const [k, row] of rows(live.r)) {
          if (Array.isArray(row) && Number.isFinite(row[0]) && Number.isFinite(row[1]) &&
              Number.isFinite(row[2]) && at - row[0] <= row[2] && !this.rates.has(k)) {
            this.rates.set(k, { start: row[0], n: row[1], w: row[2] });
          }
        }
      }
    } catch (e) {
      /* a fresh object, or storage having a bad day: start from nothing */
    }
    this.ready = true;
  }

  /* run the work once storage has been read back: at once when it already has */
  whenReady(work) {
    return this.ready ? work() : this.load().then(work);
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
  beat(who, token, game, creditTo, server) {
    return this.whenReady(() => this.beatNow(who, token, game, creditTo, server));
  }

  beatNow(who, token, game, creditTo, server) {
    const at = this.now();
    const key = who ? String(who) : null;
    /* the row this beat is about to replace is what says how long they have been in
       there; two tabs of one member share one row, so wall-clock time is never doubled */
    const prev = key ? this.members.get(key) : (token ? this.guests.get(token) : null);
    const had = prev && prev.game ? prev.game : null;
    this.credit(prev, creditTo != null ? creditTo : key, at);
    const row = { at: at, game: game || null };
    if (key) {
      /* which server, for a member who is in a game and really named a public one. A
         beat without one clears whatever was there - leaving the game, or a game that
         never had servers. */
      row.server = row.game && isPublicId(server) ? String(server) : '';
      this.members.set(key, row);
      this.dirtyLive = true;
    } else if (token) {
      if (this.guests.size < MAX_WATCHED || this.guests.has(token)) this.guests.set(token, row);
      /* a guest who is in no game is nobody's business and is not worth a write */
      if (row.game || had) this.dirtyLive = true;
    }
    this.sweep();
    return this.maybeSave().then(() => ({ ok: true }));
  }

  /*
   * Someone is on the site: keep them "here" without claiming they are in a game.
   * Loading any page counts, which is what stops a person flickering offline between
   * pages - the leave beacon fires on every navigation, not only when a tab closes.
   */
  touch(who) {
    if (!who) return Promise.resolve({ ok: true });
    return this.whenReady(() => {
      const key = String(who);
      const row = this.members.get(key);
      const at = this.now();
      /* a burst of page loads is one write, not one each: inside the window the row
         is left exactly as it is, clock and all, so no time is owed twice */
      if (row && at - row.at <= TOUCH_EVERY) return { ok: true };
      /* this rewrites `at`, so whatever time that row was owed has to be credited first */
      this.credit(row, key, at);
      /* a page load says nothing about the game or the server: whatever the beats said
         is kept exactly as it was */
      this.members.set(key, {
        at: at,
        game: row ? row.game : null,
        server: row ? (row.server || '') : ''
      });
      this.dirtyLive = true;
      return this.maybeSave().then(() => ({ ok: true }));
    });
  }

  /* The way out. The tail of the stretch counts too, before the row goes. */
  leave(who, token, creditTo) {
    return this.whenReady(() => {
      const key = who ? String(who) : null;
      const prev = key ? this.members.get(key) : (token ? this.guests.get(token) : null);
      this.credit(prev, creditTo != null ? creditTo : key, this.now());
      if (key && this.members.delete(key)) this.dirtyLive = true;
      if (token) {
        const was = this.guests.get(token);
        if (this.guests.delete(token) && was && was.game) this.dirtyLive = true;
      }
      return this.maybeSave().then(() => ({ ok: true }));
    });
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
    this.dirtyLive = true;
    this.visits.set(game, (this.visits.get(game) || 0) + 1);
    this.dirtyVisits = true;
    await this.maybeSave();
    return { ok: true, counted: true };
  }

  /*
   * Written straight away, because this object may be asleep ten seconds from now -
   * but only the keys that really changed, so a call that changed nothing costs nothing.
   */
  async maybeSave() {
    if (!this.storage) return;
    if (!this.dirtyLive && !this.dirtyVisits && !this.dirtyRecent && !this.dirtyTime) return;
    /* never write before reading: a cold object would otherwise put its handful of
       seconds where everything counted so far used to be */
    await this.load();
    this.savedAt = this.now();
    const jobs = [];
    if (this.dirtyLive) jobs.push(['live', this.liveOut(), 'dirtyLive']);
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

  /* The live part as it goes to storage: only what is still true right now. */
  liveOut() {
    const at = this.now();
    const m = {};
    const g = {};
    const v = {};
    const r = {};
    for (const [k, row] of this.members) {
      if (at - row.at > GONE_AFTER) continue;
      /* the third item only when there is one: an ordinary row stays the size it was */
      m[k] = row.game && row.server
        ? [row.at, row.game, row.server]
        : [row.at, row.game || null];
    }
    for (const [k, row] of this.guests) {
      if (row.game && at - row.at <= GONE_AFTER) g[k] = [row.at, row.game];
    }
    for (const [k, seen] of this.seenVisit) if (at - seen < VISIT_WINDOW) v[k] = seen;
    for (const [k, row] of this.rates) {
      if (Number.isFinite(row.w) && at - row.start <= row.w) r[k] = [row.start, row.n, row.w];
    }
    return { m: m, g: g, v: v, r: r };
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
      members[id] = {
        at: row.at,
        game: row.game || null,
        /* only a real public server, and only while they are in a game */
        server: row.game && isPublicId(row.server) ? row.server : ''
      };
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
    return this.whenReady(() => {
      const out = this.rateNow(key, limit, windowMs);
      return this.maybeSave().then(() => out);
    });
  }

  rateNow(key, limit, windowMs) {
    const at = this.now();
    const row = this.rates.get(key);
    this.dirtyLive = true;
    if (!row || at - row.start > windowMs) {
      this.rates.set(key, { start: at, n: 1, w: windowMs });
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
    if (cmd === 'beat') {
      return this.beat(body.who, body.token, body.game, body.creditTo, body.server);
    }
    if (cmd === 'leave') return this.leave(body.who, body.token, body.creditTo);
    if (cmd === 'visit') return this.visit(body.game, body.who);
    if (cmd === 'snapshot') {
      if (body.touch) await this.touch(body.touch);
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
    /* creditTo: whose own play time this beat belongs to, hidden presence and all.
       server: which public server of that game, for a named member only. */
    async beat(who, token, game, creditTo, server) {
      return (await call({
        cmd: 'beat', who: who, token: token, game: game, creditTo: creditTo || null,
        server: server || ''
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
