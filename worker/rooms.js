/*
 * ROOMS - the servers members' games meet in.
 *
 * A member's game is static files on their own GitHub Pages, so it has no server of its
 * own and online players have nowhere to meet. This is that nowhere: a relay. Everybody
 * in one server gets everybody else's messages. The Hub reads nothing in them and keeps
 * none of them.
 *
 * A game has three ways in, and they are all one WebSocket to /room:
 *   PUBLIC, AUTOMATIC   want=any     put me in a public server of this game that still
 *                                    has space - the fullest one first - or open a new
 *                                    one. The player types nothing.
 *   A GIVEN SERVER      want=server  that public server by its id, which the game got
 *                                    from the list below. Full or gone: by default the
 *                                    player is matched automatically instead and the
 *                                    hello says so; with only=1 it is bye: full.
 *   PRIVATE             want=new     open a new private server and be told its code
 *                       code=ABCD    a private server by its code (the old way in, and
 *                                    still exactly the same apart from honouring max)
 * and one plain GET, /room/servers?g=<game>, for the list of a game's public servers.
 *
 * Public and private servers live in separate name spaces, so a code can never be
 * guessed into a public server and a public id can never be typed as a code:
 *   private  <login>/<game>/ABCD     3-12 letters or numbers, upper case, chosen or
 *                                    generated here, never listed, never matched into
 *   public   <login>/<game>/s-ab12cd  "s-" and lower case - a shape CODE_RE refuses
 *
 * It lives on the Durable Object the Hub already has (class Presence), under a second
 * instance named "rooms", so no new class and no migration. All servers are in that one
 * instance: the group is small, and one instance makes the daily cap below a single
 * number instead of a sum nobody can see.
 *
 * NOTHING A SERVER NEEDS LIVES IN MEMORY.
 * Cloudflare puts an idle object to sleep after about ten seconds and its memory is
 * gone, while the sockets stay connected and wake it again on the next message. So
 * WHICH SERVERS EXIST, who is in them, each one's max, whether it is public or private,
 * their id, their name and their join order are all read back from the socket tags and
 * the per-socket attachments on every single call, and the day's message count is read
 * back from storage. Every handler here is written to work on a brand new object that
 * has never seen those sockets before - which, on a quiet evening, is what every handler
 * really gets. An empty server therefore needs no cleaning up: no sockets, no server.
 * The only things kept in memory are a cache of the day's count (read from storage
 * before it is trusted) and the per-connection rate buckets, whose reset is harmless:
 * a flooder gets a fresh bucket after a sleep, and the daily cap still holds.
 *
 * Every socket carries two tags: its server (the room key) and its game
 * ("g:<login>/<game>"). So "every public server of this game" is one getWebSockets with
 * the game tag and never a walk over all 150 sockets. Cloudflare allows 10 tags of 256
 * characters; a login is at most 39 and a game name at most 60, so both tags fit.
 *
 * RoomsCore is the logic on its own, with the clock, the storage and the socket
 * operations passed in, so the tests drive it with fake sockets and no Cloudflare.
 */

import { clean } from './validate.js';

/* ---------- the caps, and why each one is where it is ---------- */

/* 12 players in a server: past that a browser-hosted game cannot keep up anyway. A
   game may set its own max below it, and 12 is what it gets if it says nothing. */
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
/* At most 50 servers in one list: a game shows a page of servers, not a directory, and
   the answer stays small enough to be cheap. */
export const MAX_LIST = 50;

export const MAX_NAME = 24;

const GAME_RE = /^[A-Za-z0-9._-]{1,60}$/;
const CODE_RE = /^[A-Za-z0-9]{3,12}$/;
/* A public server id. The dash is the whole point: CODE_RE cannot match it, so no code
   a player types can ever reach a public server, however it is capitalised. */
const PUBLIC_RE = /^s-[a-z0-9]{4,12}$/;
const PID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const GITHUB_IO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\.github\.io$/;

/* no I and no O in a private code: nothing for a friend to mistype */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/* and a public id is never typed at all, so it only has to be short and unlikely */
const ID_LETTERS = 'abcdefghijkmnopqrstuvwxyz23456789';

export const WAYS = ['any', 'server', 'new', 'code'];

/* ---------- who may connect, and with what ---------- */

/*
 * The origin a game is played from, turned into the member it belongs to.
 *
 * BE HONEST ABOUT WHAT THIS IS WORTH: a browser sets Origin and cannot be talked out of
 * it, so this keeps OTHER WEBSITES from using the Hub as their relay. A script that is
 * not a browser can put whatever it likes here. The caps above are the real protection,
 * and there is nothing in a server worth stealing: no keys, no accounts, no stored
 * messages.
 *
 * `logins` is the set of Hub member logins in lower case, plus the Hub owner's.
 * A local development origin answers "local", so a member's Claude can test a game
 * before it is ever uploaded - its servers can never meet a real game's (see gameKeyOf).
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

/* Two different members' games can never share a server, and neither can two games of
   one member, because the owner and the game's name are both in the key. The game key
   is also the tag every one of its sockets carries. */
export function gameKeyOf(login, game) {
  return login + '/' + String(game).toLowerCase();
}

export function gameTagOf(gameKey) {
  return 'g:' + gameKey;
}

/* a private server: its code, in capitals */
export function roomKeyOf(login, game, code) {
  return gameKeyOf(login, game) + '/' + String(code).toUpperCase();
}

/* a public server: its id, in lower case */
export function publicKeyOf(login, game, id) {
  return gameKeyOf(login, game) + '/' + String(id).toLowerCase();
}

export function codeOf(room) {
  const parts = String(room || '').split('/');
  return parts.length === 3 ? parts[2] : '';
}

export function gameOfRoom(room) {
  const parts = String(room || '').split('/');
  return parts.length === 3 ? parts[0] + '/' + parts[1] : '';
}

/* Which name space a server id belongs to - read from the id itself, so a server is
   public or private by its shape and nothing else has to be remembered. */
export function isPublicId(id) {
  return PUBLIC_RE.test(String(id || ''));
}

/* 1 to 12, and the full 12 for a game that did not say (nothing, or an empty box). */
export function clampMax(n) {
  if (n === null || n === undefined || n === '') return MAX_PLAYERS;
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return MAX_PLAYERS;
  if (v < 1) return 1;
  if (v > MAX_PLAYERS) return MAX_PLAYERS;
  return v;
}

export function cleanName(raw) {
  return clean(raw, MAX_NAME) || 'Player';
}

/*
 * Everything the Worker has to be sure of before a socket is opened. The object itself
 * trusts nothing that came from the client: the Worker hands it only what came back
 * from here.
 *
 * The way in is `want`: any, server or new. No `want` at all means the old way, a
 * private code, and then `code` is required - so a game written before any of this
 * existed is unchanged.
 */
export function roomRequest(url, origin, logins) {
  const login = originLogin(origin, logins);
  if (!login) return { ok: false, status: 403, error: 'rooms are for games on the Hub' };
  const game = url.searchParams.get('g') || '';
  if (!GAME_RE.test(game)) return { ok: false, status: 400, error: 'which game?' };
  const want = url.searchParams.get('want') || '';
  const rawCode = url.searchParams.get('code') || '';
  if (want && WAYS.indexOf(want) < 0) {
    return { ok: false, status: 400, error: 'that is not a way into a game' };
  }
  if (want && want !== 'code' && rawCode) {
    return { ok: false, status: 400, error: 'a code or a public server, not both' };
  }
  const way = want || 'code';

  const gameKey = gameKeyOf(login, game);
  let room = '';
  let code = '';
  if (way === 'code') {
    code = rawCode.toUpperCase();
    if (!CODE_RE.test(code)) {
      return { ok: false, status: 400, error: 'a room code is 3 to 12 letters or numbers' };
    }
    room = roomKeyOf(login, game, code);
  } else if (way === 'server') {
    /* exactly as the object spelled it when it handed the id out: one shape, one
       spelling, so there is never a second way to name the same server */
    const id = url.searchParams.get('server') || '';
    if (!PUBLIC_RE.test(id)) return { ok: false, status: 400, error: 'which server?' };
    room = publicKeyOf(login, game, id);
  }

  const pid = url.searchParams.get('pid') || '';
  if (!PID_RE.test(pid)) return { ok: false, status: 400, error: 'bad player id' };
  return {
    ok: true,
    login: login,
    game: game,
    gameKey: gameKey,
    way: way,
    code: code,
    room: room,
    /* out of range is clamped, never refused: a game asking for 20 players gets 12 */
    max: clampMax(url.searchParams.get('max')),
    strict: url.searchParams.get('only') === '1',
    pid: pid,
    name: cleanName(url.searchParams.get('name'))
  };
}

/* The list request: the same origin rules, and nothing else to get wrong. A game can
   only ever ask for its own servers, because the login comes from the Origin. */
export function serversRequest(url, origin, logins) {
  const login = originLogin(origin, logins);
  if (!login) return { ok: false, status: 403, error: 'rooms are for games on the Hub' };
  const game = url.searchParams.get('g') || '';
  if (!GAME_RE.test(game)) return { ok: false, status: 400, error: 'which game?' };
  return { ok: true, login: login, game: game, gameKey: gameKeyOf(login, game) };
}

/* ---------- the servers themselves ---------- */

export class RoomsCore {
  /*
   * ops.storage   the object's storage (the day's counter)
   * ops.now       the clock
   * ops.accept    (ws, tags) -> state.acceptWebSocket: hibernation, never ws.accept()
   * ops.sockets   (tag) -> state.getWebSockets(tag); no tag means every socket
   * ops.random    (n) -> n random bytes; only the tests ever pass this
   */
  constructor(ops) {
    const o = ops || {};
    this.storage = o.storage || null;
    this.now = o.now || (() => Date.now());
    this.acceptWs = o.accept || (() => {});
    this.socketsOf = o.sockets || (() => []);
    this.random = o.random || null;
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

  /* ---------- random ids, and nothing else random ---------- */

  bytes(n) {
    if (this.random) return this.random(n);
    try {
      const buf = new Uint8Array(n);
      crypto.getRandomValues(buf);
      return buf;
    } catch (e) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
      return buf;
    }
  }

  pick(letters, n) {
    const b = this.bytes(n);
    let out = '';
    for (let i = 0; i < n; i++) out += letters.charAt(b[i] % letters.length);
    return out;
  }

  /* An id nothing in this game is using. The ids come back from the sockets, so a
     brand new object picks just as safely as one that has been awake all evening. */
  freshId(servers, wide) {
    const taken = new Set((servers || []).map((s) => s.id));
    for (let i = 0; i < 40; i++) {
      const id = 's-' + this.pick(ID_LETTERS, 6);
      if (!taken.has(id)) return id;
    }
    return 's-' + this.pick(ID_LETTERS, wide || 10);
  }

  freshCode(servers, wide) {
    const taken = new Set((servers || []).map((s) => s.id));
    for (let i = 0; i < 40; i++) {
      const code = this.pick(CODE_LETTERS, 4);
      if (!taken.has(code)) return code;
    }
    return this.pick(CODE_LETTERS, wide || 8);
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

  /* A socket that is closing or closed is not in a server any more, even while
     getWebSockets still hands it over. */
  isLive(ws) {
    const s = ws && ws.readyState;
    return s === undefined || s === null || s === 1;
  }

  /* Who is in a server, straight from the tags and the attachments. */
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

  /* every open socket on the object, servers and games alike: the 150 cap */
  liveCount() {
    let n = 0;
    for (const ws of this.socketsOf() || []) if (this.isLive(ws)) n++;
    return n;
  }

  /*
   * EVERY SERVER OF ONE GAME, from that game's tag: one getWebSockets, never a walk
   * over the whole object. A server is its sockets and nothing else, so a server with
   * nobody in it is simply not in this list.
   *
   * players counts distinct player ids, not sockets: a player whose old socket has not
   * closed yet is one player, never two.
   */
  servers(gameKey) {
    if (!gameKey) return [];
    const prefix = gameKey + '/';
    const byRoom = new Map();
    for (const ws of this.socketsOf(gameTagOf(gameKey)) || []) {
      if (!this.isLive(ws)) continue;
      const att = this.attOf(ws);
      if (!att || !att.p || typeof att.r !== 'string') continue;
      if (att.r.indexOf(prefix) !== 0) continue;
      let row = byRoom.get(att.r);
      if (!row) {
        const id = att.r.slice(prefix.length);
        row = { room: att.r, id: id, open: isPublicId(id), rows: [], pids: new Set() };
        byRoom.set(att.r, row);
      }
      row.rows.push({ ws: ws, att: att });
      row.pids.add(String(att.p));
    }
    const out = [];
    for (const row of byRoom.values()) {
      /* the max was set by whoever opened the server: the longest-present socket, the
         same rule that names the host, so a later joiner cannot change it */
      const first = this.firstOf(row.rows);
      row.max = clampMax(first && first.att ? first.att.m : MAX_PLAYERS);
      row.players = row.pids.size;
      out.push(row);
    }
    return out;
  }

  /* Fullest first, so the players of a game end up together instead of spread one to a
     server; ties by id so the answer is the same twice running. */
  byFullest(list) {
    return list.slice().sort((a, b) => {
      if (a.players !== b.players) return b.players - a.players;
      return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
    });
  }

  /* The list a game shows: PUBLIC servers only, never a private one. */
  serverList(gameKey) {
    const open = this.servers(gameKey).filter((s) => s.open);
    return this.byFullest(open).slice(0, MAX_LIST)
      .map((s) => ({ id: s.id, players: s.players, max: s.max }));
  }

  /* The host is whoever has been in the server longest: the lowest join stamp, and the
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
     is tagged "bye", never a server, so it is never counted as a player. */
  refuse(ws, why) {
    try {
      this.acceptWs(ws, ['bye']);
    } catch (e) {
      /* then it cannot be told; it is closed below all the same */
    }
    this.bye(ws, why);
    return { ok: false, why: why };
  }

  /*
   * ---------- joining ----------
   *
   * params.game    "<login>/<game>", already cleaned by the Worker
   * params.way     any | server | new | code
   * params.room    the finished server key, for "server" and "code"
   * params.max     1..12, what to open a NEW server with
   * params.strict  "server" means that one or nothing
   * params.pid     the player's own id
   * params.name    their name, already cleaned
   */
  async connect(ws, params) {
    const p = params || {};
    const pid = p.pid;
    const gameKey = typeof p.game === 'string' ? p.game : '';
    const way = WAYS.indexOf(p.way) >= 0 ? p.way : 'code';
    const asked = typeof p.room === 'string' ? p.room : '';
    if (!pid || !gameKey) return this.refuse(ws, 'bad');
    if ((way === 'code' || way === 'server') && gameOfRoom(asked) !== gameKey) {
      return this.refuse(ws, 'bad');
    }
    if (way === 'code' && isPublicId(codeOf(asked))) return this.refuse(ws, 'bad');
    if (way === 'server' && !isPublicId(codeOf(asked))) return this.refuse(ws, 'bad');
    await this.ensureDay();
    const name = cleanName(p.name);
    const wanted = clampMax(p.max);
    const strict = p.strict === true;

    if (this.liveCount() >= MAX_SOCKETS) return this.refuse(ws, 'full');
    if (this.atCap()) return this.refuse(ws, 'limit');

    /*
     * MATCHMAKING IS ONE SYNCHRONOUS PASS from here to serializeAttachment: nothing is
     * awaited, so two players arriving in the same instant cannot both be given the
     * last place in a server.
     */
    const all = this.servers(gameKey);
    const byRoom = new Map();
    for (const s of all) byRoom.set(s.room, s);
    /* the PUBLIC server this player is already in, if they are coming back. A private
       one is never matched into, not even for the player who is sitting in it. */
    let mineIn = null;
    for (const s of all) if (s.open && s.pids.has(String(pid))) mineIn = s;

    let room = '';
    let found = null;
    let fell = false;

    if (way === 'code' || way === 'server') {
      const there = byRoom.get(asked) || null;
      if (there && (there.pids.has(String(pid)) || there.players < there.max)) {
        /* a returning player is never an extra player, even in a full server */
        room = asked;
        found = there;
      } else if (way === 'code') {
        /* a private code has nowhere else to go */
        if (there) return this.refuse(ws, 'full');
        room = asked;
      } else if (!there) {
        /* that public server has emptied. Asked for by name it simply exists again;
           asked for loosely, matchmaking knows better where the players are. */
        if (strict) room = asked;
        else fell = true;
      } else if (strict) {
        return this.refuse(ws, 'full');
      } else {
        fell = true;
      }
    }

    if (!room && way === 'new') {
      /* a private server nobody else is in, with a code no friend has to guess at */
      room = gameKey + '/' + this.freshCode(all);
    }

    if (!room) {
      /* automatic: the player's own server first, then the fullest with space, then a
         new one. Private servers are not in this list and never will be. */
      if (mineIn) {
        room = mineIn.room;
        found = mineIn;
      } else {
        const open = this.byFullest(all.filter((s) => s.open && s.players < s.max));
        if (open.length) {
          room = open[0].room;
          found = open[0];
        } else {
          room = gameKey + '/' + this.freshId(all);
        }
      }
    }

    const id = codeOf(room);
    const isOpen = isPublicId(id);
    /* the opener's max, read back from the longest-present socket; only a brand new
       server takes the max the joiner asked for */
    const max = found ? found.max : wanted;
    const here = found ? found.rows : [];
    const mine = here.filter((r) => r.att.p === pid);
    const others = here.filter((r) => r.att.p !== pid);
    const heads = new Set(others.map((r) => String(r.att.p)));
    if (!mine.length && (heads.size >= max || heads.size >= MAX_PLAYERS)) {
      return this.refuse(ws, 'full');
    }

    /*
     * A second connection with the same id is the same player coming back (a reload, a
     * dropped link, a deploy of the Hub). It takes over the old one's place in the
     * queue, so the player list and the host do not flap, and the old socket is told
     * "replaced" rather than being reported as having left.
     */
    let q = this.now();
    for (const r of mine) if (r.att.q < q) q = r.att.q;

    const att = { r: room, p: pid, n: name, q: q, m: max };
    this.acceptWs(ws, [room, gameTagOf(gameKey)]);
    ws.serializeAttachment(att);
    for (const r of mine) this.bye(r.ws, 'replaced');

    const me = { ws: ws, att: att };
    const inRoom = others.concat([me]);
    inRoom.sort((a, b) => (this.earlier(a.att, b.att) ? -1 : 1));
    const host = this.firstOf(inRoom);
    const hello = {
      t: 'hello',
      you: pid,
      host: host ? host.att.p : pid,
      /* a code is a thing a friend types, so a public server has none */
      code: isOpen ? '' : id,
      server: id,
      private: !isOpen,
      max: max,
      players: inRoom.map((r) => ({ id: r.att.p, name: r.att.n }))
    };
    /* the game asked for one server and got another: say so rather than pretend */
    if (fell) hello.fell = true;
    this.tell(ws, hello);
    if (!mine.length) this.shout(others, { t: 'join', id: pid, name: name });
    return {
      ok: true, host: hello.host, q: q, room: room, server: id,
      private: !isOpen, max: max, fell: fell
    };
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
       somebody leaving, and the server is told nothing */
    if (left.some((r) => r.att.p === att.p)) return { ok: true, replaced: true };

    this.shout(left, { t: 'leave', id: att.p });
    const host = this.firstOf(left);
    /* whoever was first is gone, so the next-longest has the server now */
    if (host && this.earlier(att, host.att)) {
      this.shout(left, { t: 'host', id: host.att.p });
      return { ok: true, host: host.att.p };
    }
    return { ok: true };
  }
}
