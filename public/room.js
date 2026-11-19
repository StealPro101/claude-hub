/*
 * HubRoom - online play for a game on the Hub. READ THIS WHOLE COMMENT: it is the
 * documentation. Nothing else to install, nothing to sign up for, no keys.
 *
 * WHAT IT IS
 * Your game is static files on your own GitHub Pages, so it has no server and online
 * players have nowhere to meet. The Hub is that meeting point: everybody in the same
 * server gets everybody else's messages, and nothing else happens. The Hub does not
 * read what you send, does not keep it, and knows nothing about your game's rules.
 *
 * PUT THIS IN YOUR PAGE
 *   <script src="https://hub.sp101.workers.dev/room.js"></script>
 * It works from https://<your-login>.github.io/<your-repo>/ and from a copy of the game
 * running on your own computer (http://localhost:... or http://127.0.0.1:...). From any
 * other address the Hub turns the connection down.
 *
 * THE THREE WAYS IN
 *
 * 1. JUST PUT ME IN A SERVER. This is what most games want, and nobody types anything:
 *      var room = HubRoom.play({ max: 3, name: myName });
 *    You say how many players fit in ONE server (1 to 12). The Hub puts this player in
 *    a server of your game that still has space - the fullest one first, so players end
 *    up together - and opens a new one when they are all full. A fourth player of a
 *    3-player game lands in a second server without noticing.
 *
 * 2. THAT SERVER, THE ONE THEY PICKED. Show the servers and let the player choose:
 *      HubRoom.servers(function (list) {
 *        // list is [{ id: 's-ab12cd', players: 2, max: 3 }, ...], fullest first
 *      });
 *      var room = HubRoom.play({ max: 3, server: 's-ab12cd' });
 *    If that one filled up while they were looking, they are put in another one
 *    instead (room.server says which, and the 'open' event has already fired).
 *
 * 3. PRIVATE, FOR FRIENDS. One player opens it and reads out the code; the others type
 *    it. A private server is never listed and never used for 1. above:
 *      var room = HubRoom.host({ max: 3, name: myName });   // then show room.code
 *      var room = HubRoom.join({ code: 'ABCD', name: myName });
 *    room.code is only there once the Hub has answered, so show it in 'open'.
 *
 * THE WHOLE API
 *   HubRoom.play({ max: 3, name: 'Sam' })      a public server with space, or a new one
 *   HubRoom.play({ max: 3, server: id })       that public server (another if it is full)
 *   HubRoom.host({ max: 3, name: 'Sam' })      a new private server; room.code is its code
 *   HubRoom.join({ code: 'ABCD', name: 'Sam' }) a private server by its code
 *   HubRoom.servers(function (list) {})        this game's public servers
 *   HubRoom.newCode()                          a 4-letter code with no look-alike letters
 *   room.on('open',    function (info) {});    // info.me, info.host, info.players
 *   room.on('join',    function (player) {});  // { id: '...', name: '...' }
 *   room.on('leave',   function (player) {});  // { id: '...', name: '...' }
 *   room.on('host',    function (id) {});      // room.isHost is already updated
 *   room.on('message', function (data, from) {});
 *   room.on('close',   function (why) {});     // see the reasons below
 *   room.send(data);                           // to everybody else in the server
 *   room.sendTo(id, data);                     // to one player
 *   room.leave();
 *   room.me        your own player id
 *   room.host      the id of the player whose browser should be running the game
 *   room.isHost    true when that is you
 *   room.players   [{ id, name }, ...], the host first, in the order they joined
 *   room.server    which server you are in ('s-ab12cd', or the code of a private one)
 *   room.max       how many players fit in it
 *   room.isPrivate true when it was opened with host() or reached with join()
 *   room.code      the code friends type - a private server only, '' for a public one
 *   room.connected true while the socket is up. A dropped connection is NOT a 'close':
 *                  the library tries again five times by itself, with the same player
 *                  id, back into the SAME server, and fires 'open' again when it is
 *                  back. Show "Reconnecting..." while room.connected is false, so a
 *                  player is never left guessing.
 *
 * All four take name (up to 24 characters, default "Player") and game (default: the
 * folders in the page's address, so a game at /space-dodge/ is the game "space-dodge" -
 * two different games never share a server). max is 1 to 12, anything else is clamped,
 * and 12 is what you get if you leave it out. Whoever OPENS a server sets its max; a
 * player who joins later and asks for a different one is ignored.
 * HubRoom.servers never throws and hands you [] if anything at all goes wrong, so draw
 * a "no servers yet" list from it and let the player press Play anyway.
 * If the page's address carries ?hubserver=<id>, play() uses it on its own, so a link
 * into a friend's server works without your game doing anything.
 *
 * 'open' fires again after a reconnect. 'close' is the end: why is 'left' (you called
 * leave), 'lost' (the Hub could not be reached after five tries), 'full' (that server
 * is full and no other would do, or the Hub is at its limit), 'limit' (the Hub has
 * relayed its messages for today), 'replaced' (the same player opened the game in
 * another tab), 'slow' (way too many messages), 'big' (a message over 16 KB) or 'bad'.
 *
 * THE LIMITS, AND THE ONE RULE THAT MATTERS
 *   12 players in a server. 16 KB a message.
 *   KEEP IT UNDER ABOUT 15 MESSAGES A SECOND PER PLAYER: send positions and state ON A
 *   TIMER (setInterval, 10-15 times a second), NEVER one message per animation frame.
 *   Move things smoothly between the updates you get instead - every game worth playing
 *   does it that way, and the Hub's daily allowance is shared by all of us.
 *   Over the limit is dropped silently; a player who keeps flooding is disconnected.
 *
 * TREAT EVERYTHING YOU RECEIVE AS UNTRUSTED.
 * It came from another player's browser, not from the Hub. Never put it into innerHTML,
 * never eval it, never trust a number without checking it. Use textContent for names.
 *
 * THE PATTERN FOR A GAME THAT USED TO HAVE ITS OWN SERVER
 * The host's browser is the server: it runs the rules and sends the whole state, the
 * others send what their player is trying to do.
 *   room.on('message', function (d, from) {
 *     if (room.isHost) { applyInput(from, d); }        // a player's input
 *     else if (d.state) { last = d.state; draw(last); } // the host's state
 *   });
 *   setInterval(function () {
 *     if (room.isHost) { step(); room.send({ state: world }); }
 *   }, 80);
 * EVERY player keeps the last full state it received. If a 'host' event names you, carry
 * on from that state: you are the host now, nothing else changes. That is the whole
 * handover, and it is why a game should never keep anything only the host knows.
 *
 * Loading this file twice is harmless: the second load gives you the same HubRoom.
 */
var HubRoom = (function () {
  'use strict';

  if (typeof window !== 'undefined' && window.HubRoom) return window.HubRoom;

  /* Where the Hub is. Normally read from this file's own <script src>, so a game works
     the same from GitHub Pages, from the Hub's own address and from a local copy. */
  var FALLBACK = 'https://hub.sp101.workers.dev';
  var MAX_MSG = 16384;
  var MAX_PLAYERS = 12;
  var CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; /* no I and no O: nothing to mistype */
  var PID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  /* a public server id, the shape the Hub makes them: never a code anybody types */
  var SERVER_RE = /^s-[a-z0-9]{4,12}$/;
  var WAITS = [500, 1000, 2000, 4000, 8000];
  var CONNECT_WAIT = 15000;
  var LIST_WAIT = 8000;
  var PID_KEY = 'hubroom.pid';
  var memoryPid = '';

  function ownSrc() {
    if (typeof document === 'undefined') return '';
    if (document.currentScript && document.currentScript.src) return document.currentScript.src;
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/\/room\.js(\?|#|$)/.test(all[i].src || '')) return all[i].src;
    }
    return '';
  }

  function hubOrigin() {
    var src = ownSrc();
    if (!src) return FALLBACK;
    try {
      var u = new URL(src, location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return FALLBACK;
      return u.origin;
    } catch (e) {
      return FALLBACK;
    }
  }

  function randomNumbers(n) {
    var out = [];
    var i;
    try {
      var buf = new Uint8Array(n);
      window.crypto.getRandomValues(buf);
      for (i = 0; i < n; i++) out.push(buf[i]);
      return out;
    } catch (e) {
      for (i = 0; i < n; i++) out.push(Math.floor(Math.random() * 256));
      return out;
    }
  }

  function newCode() {
    var r = randomNumbers(4);
    var out = '';
    for (var i = 0; i < 4; i++) out += CODE_LETTERS.charAt(r[i] % CODE_LETTERS.length);
    return out;
  }

  function makePid() {
    var r = randomNumbers(15);
    var out = 'p';
    for (var i = 0; i < r.length; i++) out += PID_LETTERS.charAt(r[i] % PID_LETTERS.length);
    return out;
  }

  /* The player's own id: the same for as long as this tab is open, so a reload or a
     dropped connection comes back as the same player and not as a second one. */
  function playerId() {
    try {
      var had = window.sessionStorage.getItem(PID_KEY);
      if (had && /^[A-Za-z0-9_-]{6,40}$/.test(had)) return had;
      var made = makePid();
      window.sessionStorage.setItem(PID_KEY, made);
      return made;
    } catch (e) {
      if (!memoryPid) memoryPid = makePid();
      return memoryPid;
    }
  }

  /* The game's name, from the page's address: /space-dodge/ is "space-dodge". Every
     folder counts, so one account's two games are never the same game. */
  function gameFromPath() {
    var parts = [];
    var raw = [];
    try {
      raw = String(location.pathname || '').split('/');
    } catch (e) {
      raw = [];
    }
    for (var i = 0; i < raw.length; i++) {
      var bit = raw[i];
      if (!bit) continue;
      /* the page itself (index.html) is not a folder */
      if (i === raw.length - 1 && /\.[A-Za-z0-9]{1,8}$/.test(bit)) continue;
      parts.push(bit);
    }
    var name = parts.join('-').replace(/[^A-Za-z0-9._-]/g, '').toLowerCase().slice(0, 60);
    return name || 'game';
  }

  function gameName(asked) {
    return String(asked || gameFromPath()).replace(/[^A-Za-z0-9._-]/g, '')
      .toLowerCase().slice(0, 60) || 'game';
  }

  function cleanName(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (s.length > 24) s = s.slice(0, 24).replace(/ $/, '');
    return s || 'Player';
  }

  function cleanCode(raw) {
    return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  }

  /* A server id is only ever something the Hub made. Anything else is not one. */
  function cleanServer(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw).toLowerCase();
    return SERVER_RE.test(s) ? s : '';
  }

  function cleanMax(raw) {
    var n = Math.floor(Number(raw));
    if (!isFinite(n) || n < 1) return 0; /* 0 means "did not say" */
    return n > MAX_PLAYERS ? MAX_PLAYERS : n;
  }

  /*
   * A server id in the page's address: hub.sp101.workers.dev will link a player
   * straight into a friend's server with ?hubserver=<id>, and play() picks it up
   * without the game doing a thing. Read once, checked for shape, anything odd ignored.
   */
  function serverFromUrl() {
    try {
      var m = /[?&]hubserver=([^&#]*)/.exec(String(location.search || ''));
      return m ? cleanServer(decodeURIComponent(m[1])) : '';
    } catch (e) {
      return '';
    }
  }

  /* read once, while this script is the one running: document.currentScript is only
     the truth now, not later inside a game's callback */
  var HUB = hubOrigin();
  var FROM_URL = serverFromUrl();

  /*
   * One way in, four shapes of it:
   *   'any'     a public server with space, or a new one
   *   'server'  that public server by id (another one if it is full)
   *   'new'     a new private server, and the Hub picks its code
   *   'code'    a private server by the code a friend read out
   */
  function open(way, opts) {
    var o = opts || {};
    var hub = HUB;
    var pid = playerId();
    var name = cleanName(o.name);
    var game = gameName(o.game);
    var max = cleanMax(o.max);
    var code = cleanCode(o.code);
    var server = cleanServer(o.server);
    var mode = way;
    var strict = false;

    /* a link into a friend's server, when the game did not name one itself */
    if (mode === 'any' && !server && FROM_URL) server = FROM_URL;
    if (mode === 'any' && server) mode = 'server';
    /* an id that is not an id is no reason to leave the player standing outside */
    if (mode === 'server' && !server) mode = 'any';

    var handlers = {};
    var sock = null;
    var tries = 0;
    var finished = false;
    var byeWhy = '';
    var timer = null;
    var guard = null;

    var room = {
      code: mode === 'code' ? code : '',
      game: game,
      me: pid,
      host: null,
      isHost: false,
      players: [],
      server: mode === 'code' ? code : (server || null),
      max: max || null,
      isPrivate: mode === 'code' || mode === 'new',
      connected: false,
      hub: hub
    };

    function emit(what, a, b) {
      var list = handlers[what] || [];
      for (var i = 0; i < list.length; i++) {
        try {
          list[i](a, b);
        } catch (e) {
          /* a game's own handler throwing must never take the connection down */
        }
      }
    }

    function clearTimers() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (guard) {
        clearTimeout(guard);
        guard = null;
      }
    }

    function finish(why) {
      if (finished) return;
      finished = true;
      room.connected = false;
      clearTimers();
      emit('close', why);
    }

    function retry() {
      if (finished) return;
      room.connected = false;
      if (byeWhy) {
        /* the Hub said why; trying again would only be told the same thing */
        finish(byeWhy);
        return;
      }
      if (tries >= WAITS.length) {
        finish('lost');
        return;
      }
      var wait = WAITS[tries] + Math.floor(Math.random() * 250);
      tries++;
      timer = setTimeout(connect, wait);
    }

    function drop(player) {
      var out = [];
      var gone = null;
      for (var i = 0; i < room.players.length; i++) {
        if (room.players[i].id === player) gone = room.players[i];
        else out.push(room.players[i]);
      }
      room.players = out;
      return gone || { id: player, name: '' };
    }

    function handle(line) {
      var m = null;
      try {
        m = JSON.parse(line);
      } catch (e) {
        return;
      }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'hello') {
        tries = 0;
        room.me = typeof m.you === 'string' ? m.you : pid;
        room.host = typeof m.host === 'string' ? m.host : null;
        room.isHost = room.host === room.me;
        room.players = [];
        if (m.players && m.players.length) {
          for (var i = 0; i < m.players.length; i++) {
            var p = m.players[i];
            if (p && typeof p.id === 'string') {
              room.players.push({ id: p.id, name: String(p.name || '') });
            }
          }
        }
        if (typeof m.code === 'string' && m.code) room.code = m.code;
        if (typeof m.max === 'number' && m.max > 0) room.max = m.max;
        if (typeof m.private === 'boolean') room.isPrivate = m.private;
        /*
         * WHICH SERVER THIS IS - and a dropped connection must come back to THIS one,
         * not to wherever matchmaking would put a new player. A private server is asked
         * for by its code; a public one by its id, with "that one or nothing", so a
         * reconnect never lands the player in a different game in progress. If it has
         * emptied in the meantime it simply exists again under the same id.
         */
        if (typeof m.server === 'string' && m.server) {
          room.server = m.server;
          if (room.isPrivate) {
            mode = 'code';
            code = m.server;
            strict = false;
          } else {
            mode = 'server';
            server = m.server;
            strict = true;
          }
        }
        room.connected = true;
        clearTimers();
        emit('open', { me: room.me, host: room.host, players: room.players.slice() });
        return;
      }
      if (m.t === 'join' && typeof m.id === 'string') {
        var who = { id: m.id, name: String(m.name || '') };
        drop(m.id);
        room.players.push(who);
        emit('join', who);
        return;
      }
      if (m.t === 'leave' && typeof m.id === 'string') {
        emit('leave', drop(m.id));
        return;
      }
      if (m.t === 'host' && typeof m.id === 'string') {
        room.host = m.id;
        room.isHost = m.id === room.me;
        emit('host', m.id);
        return;
      }
      if (m.t === 'msg' && typeof m.from === 'string') {
        emit('message', m.d, m.from);
        return;
      }
      if (m.t === 'bye') {
        byeWhy = typeof m.why === 'string' ? m.why : 'bad';
      }
    }

    function address() {
      var wsBase = hub.replace(/^http/, 'ws');
      var url = wsBase + '/room?g=' + encodeURIComponent(game) +
        '&name=' + encodeURIComponent(name) +
        '&pid=' + encodeURIComponent(pid);
      if (mode === 'code') url += '&code=' + encodeURIComponent(code);
      else {
        url += '&want=' + mode;
        if (mode === 'server') {
          url += '&server=' + encodeURIComponent(server);
          if (strict) url += '&only=1';
        }
      }
      if (max) url += '&max=' + max;
      return url;
    }

    function connect() {
      if (finished) return;
      clearTimers();
      try {
        sock = new WebSocket(address());
      } catch (e) {
        retry();
        return;
      }
      var mine = sock;
      /* a connection that never answers is not a connection */
      guard = setTimeout(function () {
        if (!room.connected && mine === sock) {
          try {
            mine.close();
          } catch (e) { /* already gone */ }
        }
      }, CONNECT_WAIT);
      mine.onmessage = function (ev) {
        if (mine === sock) handle(ev.data);
      };
      mine.onclose = function () {
        if (mine === sock) retry();
      };
      mine.onerror = function () {
        /* onclose always follows, and that is where the retry lives */
      };
    }

    function out(obj) {
      if (finished || !room.connected || !sock) return false;
      var line;
      try {
        line = JSON.stringify(obj);
      } catch (e) {
        return false;
      }
      /* too big for the Hub: dropped here, so the game is not disconnected for it */
      if (line.length > MAX_MSG) return false;
      try {
        if (sock.readyState !== 1) return false;
        sock.send(line);
        return true;
      } catch (e) {
        return false;
      }
    }

    room.on = function (what, fn) {
      if (typeof fn !== 'function') return room;
      if (!handlers[what]) handlers[what] = [];
      handlers[what].push(fn);
      return room;
    };

    room.off = function (what, fn) {
      var list = handlers[what] || [];
      var keep = [];
      for (var i = 0; i < list.length; i++) if (list[i] !== fn) keep.push(list[i]);
      handlers[what] = keep;
      return room;
    };

    /* Nothing here ever throws: a game in the middle of a frame should not have to
       wonder whether the network is up. */
    room.send = function (data) {
      return out({ d: data === undefined ? null : data });
    };

    room.sendTo = function (id, data) {
      if (typeof id !== 'string' || !id) return false;
      return out({ to: id, d: data === undefined ? null : data });
    };

    room.leave = function () {
      if (finished) return;
      var was = sock;
      sock = null;
      try {
        if (was) was.close(1000, 'bye');
      } catch (e) { /* already gone */ }
      finish('left');
    };

    if (mode === 'code' && code.length < 3) {
      /* no code, nothing to join: say so the same way everything else is said */
      setTimeout(function () {
        finish('bad');
      }, 0);
      return room;
    }
    connect();
    return room;
  }

  function play(opts) {
    return open('any', opts);
  }

  function host(opts) {
    return open('new', opts);
  }

  function join(opts) {
    return open('code', opts);
  }

  /*
   * This game's public servers, fullest first. It never throws and never leaves a game
   * waiting: anything that goes wrong - no network, a refusal, nonsense in the answer -
   * is an empty list.
   */
  function servers(a, b) {
    var fn = typeof a === 'function' ? a : (typeof b === 'function' ? b : null);
    var o = (a && typeof a === 'object' ? a : (b && typeof b === 'object' ? b : null)) || {};
    if (!fn) return;
    var done = false;
    var timer = null;
    function hand(list) {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try {
        fn(list);
      } catch (e) {
        /* the game's own callback throwing is the game's business */
      }
    }
    function tidy(body) {
      var out = [];
      var rows = body && body.servers && body.servers.length ? body.servers : [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || !cleanServer(r.id)) continue;
        var players = Math.floor(Number(r.players));
        var max = Math.floor(Number(r.max));
        if (!isFinite(players) || players < 0) continue;
        if (!isFinite(max) || max < 1) continue;
        out.push({ id: String(r.id), players: players, max: max });
      }
      return out;
    }
    try {
      timer = setTimeout(function () {
        hand([]);
      }, LIST_WAIT);
      fetch(HUB + '/room/servers?g=' + encodeURIComponent(gameName(o.game)), {
        method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store'
      }).then(function (res) {
        return res && res.ok ? res.json() : null;
      }).then(function (body) {
        hand(tidy(body));
      }, function () {
        hand([]);
      });
    } catch (e) {
      hand([]);
    }
  }

  var api = {
    play: play,
    host: host,
    join: join,
    servers: servers,
    newCode: newCode,
    hub: HUB,
    maxPlayers: MAX_PLAYERS,
    maxMessage: MAX_MSG
  };
  if (typeof window !== 'undefined') window.HubRoom = api;
  return api;
}());
