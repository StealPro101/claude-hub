/*
 * HubRoom - online play for a game on the Hub. READ THIS WHOLE COMMENT: it is the
 * documentation. Nothing else to install, nothing to sign up for, no keys.
 *
 * WHAT IT IS
 * Your game is static files on your own GitHub Pages, so it has no server and online
 * players have nowhere to meet. The Hub is that meeting point: everybody who joins the
 * same room code gets everybody else's messages, and nothing else happens. The Hub does
 * not read what you send, does not keep it, and knows nothing about your game's rules.
 *
 * PUT THIS IN YOUR PAGE
 *   <script src="https://hub.sp101.workers.dev/room.js"></script>
 * It works from https://<your-login>.github.io/<your-repo>/ and from a copy of the game
 * running on your own computer (http://localhost:... or http://127.0.0.1:...). From any
 * other address the Hub turns the connection down.
 *
 * THE WHOLE API
 *   var room = HubRoom.join({ code: 'ABCD', name: 'Sam' });
 *   room.on('open',    function (info) {});   // info.me, info.host, info.players
 *   room.on('join',    function (player) {}); // { id: '...', name: '...' }
 *   room.on('leave',   function (player) {}); // { id: '...', name: '...' }
 *   room.on('host',    function (id) {});     // room.isHost is already updated
 *   room.on('message', function (data, from) {});
 *   room.on('close',   function (why) {});    // see the reasons below
 *   room.send(data);                          // to everybody else in the room
 *   room.sendTo(id, data);                    // to one player
 *   room.leave();
 *   room.me        your own player id
 *   room.host      the id of the player whose browser should be running the game
 *   room.isHost    true when that is you
 *   room.players   [{ id, name }, ...], the host first, in the order they joined
 *   room.code      the room code, in capitals
 *   room.connected true while the socket is up. A dropped connection is NOT a 'close':
 *                  the library tries again five times by itself, with the same player
 *                  id, and fires 'open' again when it is back. Show "Reconnecting..."
 *                  while room.connected is false, so a player is never left guessing.
 *   HubRoom.newCode()   a fresh 4-letter code with no look-alike letters in it
 *
 * join() takes: code (3-12 letters or numbers, required), name (up to 24 characters,
 * default "Player") and game (default: the folders in the page's address, so a game at
 * /space-dodge/ is the game "space-dodge" - two different games never share a room).
 * 'open' fires again after a reconnect. 'close' is the end: why is 'left' (you called
 * leave), 'lost' (the Hub could not be reached after five tries), 'full' (12 players
 * already, or the Hub is at its limit), 'limit' (the Hub has relayed its messages for
 * today), 'replaced' (the same player opened the room in another tab), 'slow' (way too
 * many messages), 'big' (a message over 16 KB) or 'bad'.
 *
 * NO CODE: EVERYBODY JUST LOADS IN
 * A code is only for private rooms. For a game where anyone who presses Play lands in
 * the same fight, join a fixed room and nobody ever types anything:
 *   function enter(n) {
 *     var room = HubRoom.join({ code: 'MAIN' + n, name: myName });
 *     room.on('close', function (why) { if (why === 'full') enter(n + 1); });
 *     return room;
 *   }
 *   enter(1);   // MAIN1 holds 12 players, the 13th lands in MAIN2, and so on
 *
 * THE LIMITS, AND THE ONE RULE THAT MATTERS
 *   12 players in a room. 16 KB a message.
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
  var CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; /* no I and no O: nothing to mistype */
  var PID_LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
  var WAITS = [500, 1000, 2000, 4000, 8000];
  var CONNECT_WAIT = 15000;
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

  function cleanName(raw) {
    var s = String(raw === undefined || raw === null ? '' : raw);
    s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').replace(/^ | $/g, '');
    if (s.length > 24) s = s.slice(0, 24).replace(/ $/, '');
    return s || 'Player';
  }

  /* read once, while this script is the one running: document.currentScript is only
     the truth now, not later inside a game's callback */
  var HUB = hubOrigin();

  function join(opts) {
    var o = opts || {};
    var hub = HUB;
    var pid = playerId();
    var name = cleanName(o.name);
    var game = String(o.game || gameFromPath()).replace(/[^A-Za-z0-9._-]/g, '')
      .toLowerCase().slice(0, 60) || 'game';
    var code = String(o.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

    var handlers = {};
    var sock = null;
    var tries = 0;
    var finished = false;
    var byeWhy = '';
    var timer = null;
    var guard = null;

    var room = {
      code: code,
      game: game,
      me: pid,
      host: null,
      isHost: false,
      players: [],
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

    function connect() {
      if (finished) return;
      clearTimers();
      var wsBase = hub.replace(/^http/, 'ws');
      var url = wsBase + '/room?g=' + encodeURIComponent(game) +
        '&code=' + encodeURIComponent(code) +
        '&name=' + encodeURIComponent(name) +
        '&pid=' + encodeURIComponent(pid);
      try {
        sock = new WebSocket(url);
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

    if (code.length < 3) {
      /* no code, nothing to join: say so the same way everything else is said */
      setTimeout(function () {
        finish('bad');
      }, 0);
      return room;
    }
    connect();
    return room;
  }

  var api = { join: join, newCode: newCode, hub: HUB, maxMessage: MAX_MSG };
  if (typeof window !== 'undefined') window.HubRoom = api;
  return api;
}());
