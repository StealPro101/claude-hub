/*
 * ROOMS - the meeting point for members' games.
 *
 * A member's game is static files on their own GitHub Pages, so it has no server of its
 * own and online players have nowhere to meet. This is that nowhere: a relay. A game
 * opens a WebSocket to /room?g=<game>&code=<CODE>, and everybody who opened the same
 * room gets everybody else's messages. The Hub reads nothing in them and keeps none of
 * them.
 *
 * It lives on the Durable Object the Hub already has (class Presence), under a second
 * instance named "rooms", so no new class and no migration. All rooms are in that one
 * instance: the group is small, and one instance makes the daily cap below a single
 * number instead of a sum nobody can see.
 *
 * NOTHING A ROOM NEEDS LIVES IN MEMORY.
 * Cloudflare puts an idle object to sleep after about ten seconds and its memory is
 * gone, while the sockets stay connected and wake it again on the next message. So who
 * is in which room, their id, their name and their join order are read back from the
 * socket tags and the per-socket attachments on every single call, and the day's
 * message count is read back from storage. Every handler here is written to work on a
 * brand new object that has never seen those sockets before - which, on a quiet
 * evening, is what every handler really gets.
 * The only things kept in memory are a cache of the day's count (read from storage
 * before it is trusted) and the per-connection rate buckets, whose reset is harmless:
 * a flooder gets a fresh bucket after a sleep, and the daily cap still holds.
 *
 * RoomsCore is the logic on its own, with the clock, the storage and the socket
 * operations passed in, so the tests drive it with fake sockets and no Cloudflare.
 */

import { clean } from './validate.js';

/* ---------- the caps, and why each one is where it is ---------- */

/* 12 players in a room: past that a browser-hosted game cannot keep up anyway. */
export const MAX_PLAYERS = 12;
/* 150 sockets on the whole object: the group is a handful of friends, and one object
   that is relaying 150 at once is already far past what this site is for. */
export const MAX_SOCKETS = 150;
/* 16 KB a message: enough for a whole game state, small enough that 12 players
   shouting at once cannot fill the object's outgoing buffer. */
export const MAX_MSG = 16384;
/* 30 messages a second per connection, with a 45 burst: a game should send on a timer
   (10-15 a second), and a burst that size covers a join or a level change. */
export const RATE_PER_SEC = 30;
export const RATE_BURST = 45;
/* Over the limit is dropped silently. Only a sender that is STILL over it after 300
   dropped messages inside ten seconds - twice the whole allowance of that window - is
   cut off, so a bad second never costs a player their game. */
export const RATE_DROPS = 300;
export const RATE_WINDOW = 10000;
/*
 * THE DAILY CAP. Cloudflare bills an incoming WebSocket message at 20:1 against the
 * free plan's 100,000 Durable Object requests a day - and the site's own presence lives
 * on the same object. A million messages is 50,000 requests, which leaves the other half
 * of the day's budget to the Hub itself.
 */
export const DAILY_MSGS = 1000000;
/* The counter is written at most every 1,000 messages or 30 seconds, whichever comes
   first, and whenever a socket closes. Between writes the cap can overshoot by that
   much, which is what the half-budget above is slack for. */
export const SAVE_EVERY = 1000;
export const SAVE_AFTER = 30000;

export const MAX_NAME = 24;

const GAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
const CODE_RE = /^[A-Za-z0-9]{3,12}$/;
const PID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const GITHUB_IO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\.github\.io$/;

/* ---------- who may connect, and with what ---------- */

/*
 * The origin a game is played from, turned into the member it belongs to.
 *
 * BE HONEST ABOUT WHAT THIS IS WORTH: a browser sets Origin and cannot be talked out of
 * it, so this keeps OTHER WEBSITES from using the Hub as their relay. A script that is
 * not a browser can put whatever it likes here. The caps above are the real protection,
 * and there is nothing in a room worth stealing: no keys, no accounts, no stored
 * messages.
 *
 * `logins` is the set of Hub member logins in lower case, plus the Hub owner's.
 * A local development origin answers "local", so a member's Claude can test a game
 * before it is ever uploaded - its rooms can never meet a real game's (see roomKeyOf).
 */
export function originLogin(origin, logins) {
  if (typeof origin !== 'string' || !origin) return null;
  let u = null;
  try {
    u = new URL(origin);
  } catch (e) {
    return null;
  }
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
    return 'local';
  }
  if (u.protocol !== 'https:') return null;
  const m = GITHUB_IO_RE.exec(u.hostname);
  if (!m) return null;
  const login = m[1].toLowerCase();
  return logins && logins.has(login) ? login : null;
}

/* Two different members' games can never share a room, and neither can two games of
   one member, because the owner and the game's name are both in the key. */
export function roomKeyOf(login, game, code) {
  return login + '/' + String(game).toLowerCase() + '/' + String(code).toUpperCase();
}

export function codeOf(room) {
  const parts = String(room || '').split('/');
  return parts.length === 3 ? parts[2] : '';
}

export function cleanName(raw) {
  return clean(raw, MAX_NAME) || 'Player';
}

/*
 * Everything the Worker has to be sure of before a socket is opened. The object itself
 * trusts nothing that came from the client: the Worker hands it only what came back
 * from here.
 */
export function roomRequest(url, origin, logins) {
  const login = originLogin(origin, logins);
  if (!login) return { ok: false, status: 403, error: 'rooms are for games on the Hub' };
  const game = url.searchParams.get('g') || '';
  if (!GAME_RE.test(game)) return { ok: false, status: 400, error: 'which game?' };
  const code = (url.searchParams.get('code') || '').toUpperCase();
  if (!CODE_RE.test(code)) {
    return { ok: false, status: 400, error: 'a room code is 3 to 12 letters or numbers' };
  }
  const pid = url.searchParams.get('pid') || '';
  if (!PID_RE.test(pid)) return { ok: false, status: 400, error: 'bad player id' };
  return {
    ok: true,
    login: login,
    code: code,
    room: roomKeyOf(login, game, code),
    pid: pid,
    name: cleanName(url.searchParams.get('name'))
  };
}

/* ---------- the rooms themselves ---------- */

export class RoomsCore {
  /*
   * ops.storage   the object's storage (the day's counter)
   * ops.now       the clock
   * ops.accept    (ws, tags) -> state.acceptWebSocket: hibernation, never ws.accept()
   * ops.sockets   (tag) -> state.getWebSockets(tag); no tag means every socket
   */
  constructor(ops) {
    const o = ops || {};
    this.storage = o.storage || null;
    this.now = o.now || (() => Date.now());
    this.acceptWs = o.accept || (() => {});
    this.socketsOf = o.sockets || (() => []);
    /* the day's count: a cache of what is in storage, never believed before it is read */
    this.day = null;
    this.count = 0;
    this.savedCount = 0;
    this.savedAt = this.now();
    this.loaded = false;
    this.reading = null;
    /* per-connection rate buckets; losing these to a sleep is harmless */
    this.buckets = new Map();
  }

  /* ---------- the day's message count ---------- */

  dayOf(at) {
    return new Date(at).toISOString().slice(0, 10);
  }

  keyFor(day) {
    return 'rooms:msgs:' + day;
  }

  /* Read the count back before anything trusts it. One read however many callers,
     and one more when midnight UTC arrives under open sockets. */
  ensureDay() {
    const day = this.dayOf(this.now());
    if (this.loaded && this.day === day) return Promise.resolve();
    if (!this.reading) {
      const done = () => {
        this.reading = null;
      };
      this.reading = this.readDay(day).then(done, done);
    }
    return this.reading;
  }

  async readDay(day) {
    /* midnight under open sockets: the day that is ending keeps its tail */
    if (this.loaded && this.day && this.day !== day) await this.save();
    let n = 0;
    try {
      if (this.storage) {
        const got = await this.storage.get(this.keyFor(day));
        if (Number.isFinite(got) && got > 0) n = Number(got);
      }
    } catch (e) {
      n = 0; /* a fresh object, or storage having a bad day */
    }
    this.day = day;
    this.count = n;
    this.savedCount = n;
    this.savedAt = this.now();
    this.loaded = true;
  }

  async save() {
    if (!this.storage || !this.day || this.count === this.savedCount) return;
    const n = this.count;
    try {
      await this.storage.put(this.keyFor(this.day), n);
      this.savedCount = n;
      this.savedAt = this.now();
    } catch (e) {
      /* it stays unsaved and is written at the next message or close */
    }
  }

  /* One tiny row a day, kept: it is the only record of what the rooms cost. */
  maybeSave() {
    if (this.count - this.savedCount >= SAVE_EVERY || this.now() - this.savedAt >= SAVE_AFTER) {
      return this.save();
    }
    return Promise.resolve();
  }

  atCap() {
    return this.count >= DAILY_MSGS;
  }

  /* ---------- the sockets, read back every time ---------- */

  attOf(ws) {
    try {
      const a = ws.deserializeAttachment();
      return a && typeof a === 'object' ? a : null;
    } catch (e) {
      return null;
    }
  }

  /* A socket that is closing or closed is not in the room any more, even while
     getWebSockets still hands it over. */
  isLive(ws) {
    const s = ws && ws.readyState;
    return s === undefined || s === null || s === 1;
  }

  /* Who is in a room, straight from the tags and the attachments. */
  roomSockets(room) {
    const out = [];
    const all = this.socketsOf(room) || [];
    for (const ws of all) {
      if (!this.isLive(ws)) continue;
      const att = this.attOf(ws);
      if (att && att.r === room && att.p) out.push({ ws: ws, att: att });
    }
    return out;
  }

  liveCount() {
    let n = 0;
    for (const ws of this.socketsOf() || []) if (this.isLive(ws)) n++;
    return n;
  }

  /* The host is whoever has been in the room longest: the lowest join stamp, and the
     lower id if two arrived in the same millisecond. Nothing is stored for this, so it
     is the same answer before and after the object sleeps. */
  firstOf(rows) {
    let best = null;
    for (const r of rows) if (!best || this.earlier(r.att, best.att)) best = r;
    return best;
  }

  earlier(a, b) {
    if (a.q !== b.q) return a.q < b.q;
    return String(a.p) < String(b.p);
  }

  tell(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  shout(rows, obj) {
    const line = JSON.stringify(obj);
    for (const r of rows) {
      try {
        r.ws.send(line);
      } catch (e) {
        /* a socket that died between two lines is not worth stopping for */
      }
    }
  }

  bye(ws, why) {
    this.tell(ws, { t: 'bye', why: why });
    try {
      ws.close(1000, why);
    } catch (e) {
      /* already gone */
    }
  }

  /* A refusal still has to be able to say why, which needs an accepted socket - but it
     is tagged "bye", never the room, so it is never counted as a player. */
  refuse(ws, why) {
    try {
      this.acceptWs(ws, ['bye']);
    } catch (e) {
      /* then it cannot be told; it is closed below all the same */
    }
    this.bye(ws, why);
    return { ok: false, why: why };
  }

  /* ---------- joining ---------- */

  async connect(ws, params) {
    const room = params && params.room;
    const pid = params && params.pid;
    if (!room || !pid) return this.refuse(ws, 'bad');
    await this.ensureDay();
    const name = cleanName(params.name);

    if (this.liveCount() >= MAX_SOCKETS) return this.refuse(ws, 'full');
    if (this.atCap()) return this.refuse(ws, 'limit');

    const here = this.roomSockets(room);
    const mine = here.filter((r) => r.att.p === pid);
    const others = here.filter((r) => r.att.p !== pid);
    if (!mine.length && others.length >= MAX_PLAYERS) return this.refuse(ws, 'full');

    /*
     * A second connection with the same id is the same player coming back (a reload, a
     * dropped link, a deploy of the Hub). It takes over the old one's place in the
     * queue, so the player list and the host do not flap, and the old socket is told
     * "replaced" rather than being reported as having left.
     */
    let q = this.now();
    for (const r of mine) if (r.att.q < q) q = r.att.q;

    this.acceptWs(ws, [room]);
    ws.serializeAttachment({ r: room, p: pid, n: name, q: q });
    for (const r of mine) this.bye(r.ws, 'replaced');

    const me = { ws: ws, att: { r: room, p: pid, n: name, q: q } };
    const inRoom = others.concat([me]);
    inRoom.sort((a, b) => (this.earlier(a.att, b.att) ? -1 : 1));
    const host = this.firstOf(inRoom);
    this.tell(ws, {
      t: 'hello',
      you: pid,
      host: host ? host.att.p : pid,
      code: codeOf(room),
      players: inRoom.map((r) => ({ id: r.att.p, name: r.att.n }))
    });
    if (!mine.length) this.shout(others, { t: 'join', id: pid, name: name });
    return { ok: true, host: host ? host.att.p : pid, q: q };
  }

  /* ---------- a message ---------- */

  async message(ws, raw) {
    const att = this.attOf(ws);
    if (!att || !att.r || !att.p) {
      this.bye(ws, 'bad');
      return { ok: false, why: 'bad' };
    }
    await this.ensureDay();

    /* Cloudflare bills every incoming message, good or bad, so every one is counted. */
    this.count++;
    if (this.atCap()) {
      await this.save();
      this.bye(ws, 'limit');
      return { ok: false, why: 'limit' };
    }
    const pending = this.maybeSave();

    if (typeof raw !== 'string') {
      this.bye(ws, 'bad');
      await pending;
      return { ok: false, why: 'bad' };
    }
    if (raw.length > MAX_MSG) {
      this.bye(ws, 'big');
      await pending;
      return { ok: false, why: 'big' };
    }
    const verdict = this.take(att.r + '|' + att.p);
    if (verdict === 'slow') {
      this.bye(ws, 'slow');
      await pending;
      return { ok: false, why: 'slow' };
    }
    if (verdict === 'drop') {
      await pending;
      return { ok: false, why: 'drop' };
    }

    let body = null;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      body = null;
    }
    /* anything that is not { d: ... } is simply ignored - it has already cost the
       sender a token, which is all a wrong message should cost anybody */
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('d' in body)) {
      await pending;
      return { ok: false, why: 'ignored' };
    }
    const to = typeof body.to === 'string' ? body.to : null;
    const line = JSON.stringify({ t: 'msg', from: att.p, d: body.d });
    let sent = 0;
    for (const r of this.roomSockets(att.r)) {
      /* never back to the sender: not this socket, and not another tab of the same id */
      if (r.ws === ws || r.att.p === att.p) continue;
      if (to && r.att.p !== to) continue;
      try {
        r.ws.send(line);
        sent++;
      } catch (e) {
        /* gone mid-send; its close will tidy up after it */
      }
    }
    await pending;
    return { ok: true, sent: sent };
  }

  /* The soft limiter: a token bucket per connection, in memory on purpose. */
  take(key) {
    const at = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > MAX_SOCKETS * 2) this.buckets.clear();
      b = { tokens: RATE_BURST, at: at, drops: 0, since: at };
      this.buckets.set(key, b);
    }
    const gained = ((at - b.at) / 1000) * RATE_PER_SEC;
    if (gained > 0) b.tokens = Math.min(RATE_BURST, b.tokens + gained);
    b.at = at;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 'ok';
    }
    if (at - b.since > RATE_WINDOW) {
      b.since = at;
      b.drops = 0;
    }
    b.drops++;
    return b.drops > RATE_DROPS ? 'slow' : 'drop';
  }

  /* ---------- leaving ---------- */

  async close(ws) {
    const att = this.attOf(ws);
    /* this object may be asleep a second from now: the count goes to storage first */
    if (this.loaded) await this.save();
    if (!att || !att.r || !att.p) return { ok: true };
    this.buckets.delete(att.r + '|' + att.p);

    const left = this.roomSockets(att.r).filter((r) => r.ws !== ws);
    /* the same player still has a socket here: this was a reload being replaced, not
       somebody leaving, and the room is told nothing */
    if (left.some((r) => r.att.p === att.p)) return { ok: true, replaced: true };

    this.shout(left, { t: 'leave', id: att.p });
    const host = this.firstOf(left);
    /* whoever was first is gone, so the next-longest has the room now */
    if (host && this.earlier(att, host.att)) {
      this.shout(left, { t: 'host', id: host.att.p });
      return { ok: true, host: host.att.p };
    }
    return { ok: true };
  }
}
