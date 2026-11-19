/*
 * A game's page, in two states.
 *
 * 1. The details: picture, name, maker, one big Play button, the numbers, how to play -
 *    and, for a game that has players in it right now, its SERVERS, one row each with a
 *    way straight into that one.
 * 2. In the game: Play takes over the whole window. Nothing of the site is left except
 *    one big round Leave button in the corner, over the game. Pressing it (or Escape)
 *    asks once - Leave or Keep playing - and the browser's Back button leaves too.
 *
 * The frame is never built from the query string: the id is looked up in the Hub's own
 * data and the address the server computed from owner + repo is used. Nothing loads
 * until Play is pressed, so a game with sound never starts on its own. Joining one
 * server rather than another adds one thing to that address: ?hubserver=<id>.
 *
 * While the game is open it may say which server it ended up in (room.js posts it to
 * this page). That is worth exactly one thing: the heartbeat carries it, so a friend
 * pressing Join beside this player's name lands in the same server. A message is read
 * only if it really came from this game's own frame, and anything else is ignored
 * without a word.
 */
(function () {
  'use strict';
  var media = document.getElementById('media');
  var info = document.getElementById('info');
  var counts = document.getElementById('counts');
  var servers = document.getElementById('servers');
  var about = document.getElementById('about');
  var lower = document.getElementById('lower');
  var lowerIn = document.getElementById('lowerIn');
  var layer = document.getElementById('ingame');
  var inGame = false;
  var leaveNow = null;
  /* a server id is a thing the Hub made: "s-" and a few lower-case letters or numbers */
  var SERVER_RE = /^s-[a-z0-9]{4,12}$/;
  /* how often the list of servers is asked for again, while the page is being looked at */
  var LIST_EVERY = 20000;

  var wanted = '';
  try {
    wanted = new URLSearchParams(location.search).get('g') || '';
  } catch (e) {
    wanted = '';
  }

  /*
   * A press on Join, over on the Hub, leaves this one note behind. It is read and
   * thrown away at once, so a reload, a shared link or a bookmark can never start a
   * game by itself - only a press on Join does.
   */
  var joinWanted = '';
  var joinServer = '';
  try {
    joinWanted = sessionStorage.getItem('hubJoin') || '';
    /* and which server of it they are in, so this lands in THEIRS */
    joinServer = sessionStorage.getItem('hubJoinServer') || '';
    sessionStorage.removeItem('hubJoin');
    sessionStorage.removeItem('hubJoinServer');
  } catch (e) {
    joinWanted = '';
    joinServer = '';
  }
  if (!SERVER_RE.test(joinServer)) joinServer = '';

  /* a reload or a shared link never drops anyone straight into a game */
  if (location.hash === '#play') {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* the hash is harmless */ }
  }

  Hub.bar('explore', null);

  function nope(message) {
    document.title = 'Not here · Hub';
    [media, info, counts, servers, about].forEach(function (n) { Hub.clear(n); });
    document.getElementById('gp').classList.add('off');
    counts.classList.add('off');
    servers.classList.add('off');
    lower.classList.add('off');
    about.classList.add('gp-about--one');
    var box = Hub.box('Not on the Hub');
    box.body.appendChild(Hub.el('p', '', message));
    var row = Hub.el('p', 'btn-row');
    var a = Hub.el('a', 'btn', 'Back to the games');
    a.href = '/explore.html';
    row.appendChild(a);
    box.body.appendChild(row);
    about.appendChild(box.box);
  }

  if (!/^[A-Za-z0-9._\/-]{1,140}$/.test(wanted)) {
    Hub.data().then(function (d) { Hub.bar('explore', d); });
    nope('That game address does not look like anything on the Hub.');
    return;
  }

  Hub.data().then(function (d) {
    Hub.bar('explore', d);
    var games = d.games || [];
    var game = null;
    for (var i = 0; i < games.length; i++) {
      if (String(games[i].id).toLowerCase() === wanted.toLowerCase()) game = games[i];
    }
    if (!game) {
      nope('That game is not on the Hub (any more). Have a look at what else is here.');
      return;
    }
    var url = Hub.playUrl(game);
    if (!url) {
      nope('That game’s address did not pass the Hub’s own check, so it was not opened.');
      return;
    }
    build(d, game, url);
  }).catch(function () {
    nope('Could not reach the Hub right now. Refresh in a minute.');
  });

  function build(d, game, url) {
    var me = d.me;
    var members = d.members || [];
    var maker = Hub.memberOf(members, game.owner);
    var title = game.title || 'Untitled';
    document.title = title + ' · Hub';
    var beat = Hub.beat(null);

    /* ---- the picture ---- */
    Hub.clear(media);
    Hub.coverInto(media, game);

    /* ---- name, maker, Play ---- */
    Hub.clear(info);
    info.appendChild(Hub.el('h1', '', title));

    var by = Hub.el('div', 'gp-by');
    var av = document.createElement('img');
    av.src = Hub.avatarUrl(maker && maker.avatar, maker && maker.id);
    av.alt = '';
    by.appendChild(av);
    by.appendChild(document.createTextNode('By '));
    var who = Hub.el('a', '', game.owner);
    who.href = '/players.html#' + encodeURIComponent(game.owner);
    by.appendChild(who);
    info.appendChild(by);
    if (game.status === 'draft') {
      var note = Hub.el('div', 'gp-draft');
      note.appendChild(Hub.el('span', 'pill pill-draft', 'Draft — only you can see this'));
      /* straight to the editor for this one, not to a page of boxes */
      if (me && me.login === game.owner) {
        var fix = Hub.el('a', 'small', 'Set it up');
        fix.href = '/mygames.html#edit=' + encodeURIComponent(
          game.repo || game.id.slice(game.id.indexOf('/') + 1));
        note.appendChild(fix);
      }
      info.appendChild(note);
    }

    /* the one-line pitch sits here only when the boxes below hold something else */
    var pitch = (game.description || '').trim();
    if (pitch && ((game.howto || '').trim() || (game.notes || '').trim())) {
      info.appendChild(Hub.el('p', 'gp-desc', pitch));
    }

    var play = Hub.el('button', 'gp-play');
    play.type = 'button';
    play.setAttribute('aria-label', 'Play ' + title);
    play.appendChild(Hub.icon('play', 30));
    play.appendChild(Hub.el('span', '', 'Play'));
    info.appendChild(play);

    var nowLine = Hub.el('div', 'gp-now');
    info.appendChild(nowLine);

    /*
     * The star. A favourite is private and uncounted - the button says whether this
     * game is on YOUR list and nothing more.
     */
    var acts = Hub.el('div', 'gp-acts');
    var star = Hub.el('button', 'fav-btn' + (game.favorite ? ' on' : ''));
    star.type = 'button';
    var starWord = Hub.el('span', 'w', game.favorite ? 'Favorited' : 'Favorite');
    function paintStar() {
      Hub.clear(star);
      star.appendChild(Hub.starIcon(game.favorite, 18));
      starWord.textContent = game.favorite ? 'Favorited' : 'Favorite';
      star.appendChild(starWord);
      star.classList.toggle('on', Boolean(game.favorite));
      star.setAttribute('aria-pressed', game.favorite ? 'true' : 'false');
    }
    paintStar();
    if (!me) {
      star.disabled = true;
      starWord.textContent = 'Favorite';
      star.title = 'Sign in to favorite a game';
      star.setAttribute('aria-label', 'Favorite (sign in first)');
    } else if (game.status === 'draft') {
      star.disabled = true;
      star.title = 'Publish it first';
    } else {
      star.addEventListener('click', function () {
        var want = !game.favorite;
        star.disabled = true;
        Hub.post('/api/games/favorite', { id: game.id, on: want }).then(function (r) {
          star.disabled = false;
          if (!r.ok) return;
          game.favorite = Boolean(r.favorite);
          paintStar();
        });
      });
    }
    acts.appendChild(star);

    var copy = Hub.el('button', 'btn btn--grey btn--sm');
    copy.type = 'button';
    copy.appendChild(Hub.icon('link', 13));
    copy.appendChild(Hub.el('span', '', 'Copy link'));
    copy.addEventListener('click', function () {
      var link = location.origin + '/play.html?g=' + encodeURIComponent(game.id);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () {
          copy.querySelector('span').textContent = 'Copied';
          setTimeout(function () { copy.querySelector('span').textContent = 'Copy link'; }, 1600);
        }, function () { /* the address bar still has it */ });
      }
    });
    acts.appendChild(copy);

    var report = Hub.el('button', 'btn btn--grey btn--sm');
    report.type = 'button';
    report.appendChild(Hub.icon('flag', 13));
    report.appendChild(Hub.el('span', '', 'Report'));
    report.addEventListener('click', function () {
      if (!me) {
        report.querySelector('span').textContent = 'Sign in first';
        return;
      }
      report.disabled = true;
      Hub.post('/api/games/report', { id: game.id }).then(function (r) {
        report.querySelector('span').textContent = r.ok ? 'Sent to the owner' : (r.error || 'Not sent');
      });
    });
    acts.appendChild(report);
    info.appendChild(acts);

    /* ---- how long this game has been played ----
     *
     * A signed-in member's own time is the server's: it is counted from the beats that
     * are going out anyway, and it follows them from one computer to the next. Signed
     * out there is no account to keep it on, so it is this browser's own business - the
     * way "Recently played" is - counted here while the game is open and the tab is
     * being looked at, and never sent anywhere.
     */
    var TIME_KEY = 'hubTime';
    var TICK = 15000;
    var ticker = null;
    var since = 0;

    function localTimes() {
      try {
        var raw = JSON.parse(Hub.lsGet(TIME_KEY) || '{}');
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        return raw;
      } catch (e) {
        return {};
      }
    }

    function localSeconds() {
      return Math.max(0, Math.floor(Number(localTimes()[game.id]) || 0));
    }

    /* put the stretch since the last count away and start a new one; a blocked store
       simply never remembers anything, and the cell says 0 min */
    function keepLocal() {
      if (!since) return;
      var at = Date.now();
      var span = Math.floor((at - since) / 1000);
      if (span < 1) return;
      var all = localTimes();
      all[game.id] = localSeconds() + span;
      since = at;
      Hub.lsSet(TIME_KEY, JSON.stringify(all));
    }

    function countHere(on) {
      if (me) return;
      if (on && document.visibilityState !== 'visible') on = false;
      if (on) {
        if (!since) since = Date.now();
        if (!ticker) ticker = setInterval(keepLocal, TICK);
        return;
      }
      keepLocal();
      since = 0;
      if (ticker) {
        clearInterval(ticker);
        ticker = null;
      }
    }

    function mySeconds(g) {
      return me ? Math.max(0, Math.floor(Number(g.myTime) || 0)) : localSeconds();
    }

    /* ---- the numbers ---- */
    function drawCounts(g) {
      Hub.clear(counts);
      [
        ['Playing now', Hub.compact(g.active || 0)],
        ['Visits', Hub.compact(g.visits || 0)],
        ['Your time', Hub.duration(mySeconds(g)), true],
        ['Total time', Hub.duration(g.playTime || 0), true],
        ['Updated', Hub.niceDate(g.updated) || 'recently'],
        ['Category', g.category || 'freestyle']
      ].forEach(function (pair) {
        var cell = Hub.el('div');
        cell.appendChild(Hub.el('div', 'k', pair[0]));
        /* "under 1 min" is a sentence, not a name: it keeps its small letters */
        cell.appendChild(Hub.el('div', pair[2] ? 'n plain' : 'n', pair[1]));
        counts.appendChild(cell);
      });
      Hub.clear(nowLine);
      if (g.active > 0) {
        nowLine.appendChild(Hub.el('span', 'dot-live'));
        nowLine.appendChild(document.createTextNode(
          g.active + (g.active === 1 ? ' person is' : ' people are') + ' playing right now'));
      }
    }
    drawCounts(game);

    /* ---- the servers, when there are any ----
     *
     * A game with nobody in it, and a game that is not multiplayer at all, has no
     * servers - and then this page looks exactly as it always did: no heading, no empty
     * list, nothing. The rows are the fullest first, which is where a player wants to
     * be, and Join on a row goes into THAT server rather than wherever the game's own
     * matchmaking would have put them.
     */
    var asking = false;
    var listTimer = null;

    function tidyServers(rows) {
      var out = [];
      for (var i = 0; rows && i < rows.length; i++) {
        var r = rows[i] || {};
        var players = Math.floor(Number(r.players));
        var max = Math.floor(Number(r.max));
        if (!SERVER_RE.test(String(r.id))) continue;
        if (!isFinite(players) || players < 0) continue;
        if (!isFinite(max) || max < 1 || max > 12) continue;
        /* the Hub never lets a server past its max; drawing is not the place to argue */
        out.push({ id: String(r.id), players: Math.min(players, max), max: max });
      }
      out.sort(function (a, b) {
        return b.players - a.players || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
      });
      return out;
    }

    function serverRow(row) {
      var line = Hub.el('div', 'gp-sv-row');
      var full = row.players >= row.max;
      line.appendChild(Hub.el('span', 'gp-sv-n',
        row.players + ' of ' + row.max + (row.max === 1 ? ' player' : ' players')));
      /* one mark per place, filled for a player who is in it */
      var meter = Hub.el('span', 'gp-sv-meter');
      meter.setAttribute('aria-hidden', 'true');
      for (var i = 0; i < row.max; i++) {
        meter.appendChild(Hub.el('i', i < row.players ? 'on' : null));
      }
      line.appendChild(meter);
      var join = Hub.el('button', 'join-btn', full ? 'Full' : 'Join');
      join.type = 'button';
      if (full) {
        join.disabled = true;
        join.setAttribute('aria-label', 'That server is full');
      } else {
        join.setAttribute('aria-label', 'Join the server with ' + row.players + ' of ' +
          row.max + ' players');
        join.addEventListener('click', function () { enter(row.id); });
      }
      line.appendChild(join);
      return line;
    }

    function drawServers(rows) {
      Hub.clear(servers);
      if (!rows.length) {
        servers.classList.add('off');
        return;
      }
      servers.classList.remove('off');
      var head = Hub.el('div', 'gp-sv-head');
      var h2 = Hub.el('h2', '', 'Servers');
      h2.id = 'gpServersHead';
      head.appendChild(h2);
      head.appendChild(Hub.el('span', 'gp-sv-sub',
        rows.length === 1 ? '1 server up' : rows.length + ' servers up'));
      var again = Hub.el('button', 'btn btn--grey btn--sm gp-sv-again');
      again.type = 'button';
      again.appendChild(Hub.el('span', '', 'Refresh'));
      again.addEventListener('click', function () { refreshServers(); });
      head.appendChild(again);
      servers.appendChild(head);
      servers.setAttribute('aria-labelledby', 'gpServersHead');
      var list = Hub.el('div', 'gp-sv-rows');
      for (var i = 0; i < rows.length; i++) list.appendChild(serverRow(rows[i]));
      servers.appendChild(list);
    }

    function refreshServers() {
      if (asking) return Promise.resolve();
      asking = true;
      return fetch('/api/rooms/servers?g=' + encodeURIComponent(game.id), {
        credentials: 'same-origin', cache: 'no-store'
      }).then(function (res) {
        return res && res.ok ? res.json() : null;
      }).then(function (body) {
        asking = false;
        drawServers(tidyServers(body && body.ok ? body.servers : []));
      }).catch(function () {
        asking = false;
        /* a list that cannot be fetched leaves the one in front of the player alone */
      });
    }

    refreshServers();
    listTimer = setInterval(function () {
      /* not while they are in the game (the page is behind it) and not in a tab nobody
         is looking at - a hidden tab's timers are throttled to nothing anyway */
      if (!inGame && document.visibilityState === 'visible') refreshServers();
    }, LIST_EVERY);

    /* ---- how to play / notes ---- */
    Hub.clear(about);
    var howto = (game.howto || '').trim();
    var notes = (game.notes || '').trim();
    if (!howto && !notes) {
      about.classList.add('gp-about--one');
      about.appendChild(tinted('About this game', game.description || 'No notes yet.'));
    } else {
      about.appendChild(tinted('How to play', howto || 'No instructions yet.'));
      about.appendChild(tinted('Notes and credits', notes || 'Nothing here yet.'));
    }

    /* ---- the band underneath ---- */
    Hub.clear(lowerIn);
    var published = (d.games || []).filter(function (g) {
      return g.status !== 'draft' && g.id !== game.id;
    });
    var byMaker = published.filter(function (g) { return g.owner === game.owner; });
    var sameCat = published.filter(function (g) { return g.category === game.category; });
    var any = false;
    if (byMaker.length) {
      any = true;
      var b1 = Hub.box('More from ' + game.owner, {
        moreHref: '/players.html#' + encodeURIComponent(game.owner), tight: true, row: true
      });
      var m1 = byMaker.slice(0, 16);
      b1.body.appendChild(Hub.rail(m1.map(function (g) {
        return Hub.thumb(g, members, { me: me });
      }), Hub.sizeFor(m1.length)));
      lowerIn.appendChild(b1.box);
    }
    if (sameCat.length) {
      any = true;
      var b2 = Hub.box('More ' + game.category + ' games', {
        moreHref: '/explore.html?cat=' + encodeURIComponent(game.category), tight: true, row: true
      });
      var m2 = sameCat.slice(0, 16);
      b2.body.appendChild(Hub.rail(m2.map(function (g) {
        return Hub.thumb(g, members, { me: me });
      }), Hub.sizeFor(m2.length)));
      lowerIn.appendChild(b2.box);
    }
    lower.classList.toggle('off', !any);

    /* ---- in the game: the whole window, one round way out ---- */
    Hub.clear(layer);
    var host = Hub.el('div', 'ig-frame');
    layer.appendChild(host);

    var leave = Hub.el('button', 'ig-leave');
    leave.type = 'button';
    leave.setAttribute('aria-label', 'Leave game');
    leave.title = 'Leave';
    leave.appendChild(Hub.icon('exit', 26));
    leave.appendChild(Hub.el('span', 'w', 'Leave'));
    layer.appendChild(leave);

    /* the one question this layer ever asks, over the game it covers */
    var ask = Hub.el('div', 'ig-ask off');
    ask.setAttribute('role', 'dialog');
    ask.setAttribute('aria-modal', 'true');
    ask.setAttribute('aria-labelledby', 'igAskHead');
    var card = Hub.el('div', 'ig-card');
    var head = Hub.el('h2', 'ig-head', 'Leave this game?');
    head.id = 'igAskHead';
    card.appendChild(head);
    var pair = Hub.el('div', 'ig-pair');
    var yes = Hub.el('button', 'ig-big ig-yes', 'Leave');
    yes.type = 'button';
    var no = Hub.el('button', 'ig-big ig-no', 'Keep playing');
    no.type = 'button';
    pair.appendChild(yes);
    pair.appendChild(no);
    card.appendChild(pair);
    ask.appendChild(card);
    layer.appendChild(ask);

    function askLeave(on) {
      ask.classList.toggle('off', !on);
      if (on) {
        no.focus();
      } else if (inGame) {
        var frame = host.firstChild;
        if (frame && frame.focus) {
          try { frame.focus(); } catch (e) { /* the next click focuses it */ }
        }
      }
    }

    /*
     * The address the frame is given: the game's own, plus ?hubserver=<id> when the
     * player picked a server. Whatever query the play address already carries is kept,
     * and the hash is left exactly where it was - a game may well be using it.
     */
    function frameSrc(serverId) {
      if (!serverId) return url;
      var at = url.indexOf('#');
      var body = at < 0 ? url : url.slice(0, at);
      var hash = at < 0 ? '' : url.slice(at);
      body += (body.indexOf('?') < 0 ? '?' : '&') + 'hubserver=' + encodeURIComponent(serverId);
      return body + hash;
    }

    /* which server the game inside the frame says it is in, '' for none or a private one */
    var atServer = '';
    var frameOrigin = '';
    try {
      frameOrigin = new URL(url, location.href).origin;
    } catch (e) {
      frameOrigin = '';
    }

    function enter(serverId) {
      if (inGame) return;
      inGame = true;
      atServer = '';
      askLeave(false);
      var frame = document.createElement('iframe');
      frame.title = title;
      frame.setAttribute('sandbox',
        'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-popups');
      frame.setAttribute('allow', 'fullscreen; gamepad');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = frameSrc(serverId);
      Hub.clear(host);
      host.appendChild(frame);
      layer.classList.remove('off');
      document.documentElement.classList.add('in-game');
      try {
        history.pushState({ hubPlay: true }, '', location.pathname + location.search + '#play');
      } catch (e) { /* Leave still works without the history entry */ }
      try {
        frame.focus();
      } catch (e) { /* the first click in the game focuses it */ }
      /* signed out, "recently played" and "your time" are this browser's own business */
      if (!me) Hub.noteRecent(game.id);
      countHere(true);
      /*
       * Say where we are first, then count the visit. NOT which server: the one that
       * was asked for is only a wish until the game has connected, and it may well be
       * given another one. What the game itself says, below, is the only thing this
       * page ever passes on.
       */
      beat.where(game.id, '')
        .then(function () { return Hub.post('/api/presence/visit', { game: game.id }); })
        .catch(function () { /* the counts are not worth a fuss */ });
    }

    function out() {
      if (!inGame) return;
      inGame = false;
      atServer = '';
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () { /* already out */ });
      }
      Hub.clear(host);
      layer.classList.add('off');
      document.documentElement.classList.remove('in-game');
      askLeave(false);
      play.focus();
      countHere(false);
      /* out of the game is out of its server too */
      beat.where(null, '')
        .then(function () { return refreshServers(); })
        .then(function () { return Hub.data(true); })
        .then(function (fresh) {
          var g2 = (fresh.games || []).find(function (x) { return x.id === game.id; });
          if (g2) {
            game.active = g2.active;
            game.visits = g2.visits;
            /* the beat above closed the session, so these have just moved */
            game.playTime = g2.playTime;
            game.myTime = g2.myTime;
          }
          drawCounts(game);
        })
        .catch(function () { drawCounts(game); });
    }

    /* Leave goes through the history entry Play made, so Back and Leave are one path */
    leaveNow = function () {
      if (history.state && history.state.hubPlay) history.back();
      else out();
    };

    /* the big button is "put me in a server", not "that one" */
    play.addEventListener('click', function () { enter(''); });

    /*
     * WHICH SERVER THE GAME ENDED UP IN, from the game itself.
     *
     * Accepted only from this game's own frame: the window the message came from has to
     * be the frame's window AND its origin has to be the origin of the play address.
     * Then the shape is checked - a server id or nothing, small whole numbers - and
     * anything that does not fit is dropped without a word. All it is ever used for is
     * the heartbeat, so a friend's Join can land in the same server.
     */
    function smallCount(n) {
      return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 12 && n === Math.floor(n);
    }

    window.addEventListener('message', function (ev) {
      if (!inGame || !frameOrigin || ev.origin !== frameOrigin) return;
      var frame = host.firstChild;
      if (!frame || !frame.contentWindow || ev.source !== frame.contentWindow) return;
      var d = ev.data;
      if (!d || typeof d !== 'object' || d.hubRoom !== 1) return;
      if (typeof d.server !== 'string') return;
      if (d.server !== '' && !SERVER_RE.test(d.server)) return;
      if (typeof d.private !== 'boolean') return;
      if (!smallCount(d.players) || !smallCount(d.max)) return;
      /* a private server has no id to pass on, and says so itself */
      var id = d.private ? '' : d.server;
      if (id === atServer) return;
      atServer = id;
      beat.where(game.id, id).catch(function () { /* counts are never worth a fuss */ });
    });
    /* the round button opens the question, and closes it again if it is already open */
    leave.addEventListener('click', function () {
      askLeave(ask.classList.contains('off'));
    });
    no.addEventListener('click', function () { askLeave(false); });
    yes.addEventListener('click', function () { leaveNow(); });
    /* a press on the dim part, beside the card, is "keep playing" */
    ask.addEventListener('click', function (ev) {
      if (ev.target === ask) askLeave(false);
    });
    window.addEventListener('popstate', function () {
      if (inGame && !(history.state && history.state.hubPlay)) out();
    });

    document.addEventListener('keydown', function (ev) {
      if (!inGame || ev.key !== 'Escape') return;
      askLeave(ask.classList.contains('off'));
    });

    /* time off this browser's own clock only counts while somebody is looking at it */
    document.addEventListener('visibilitychange', function () {
      countHere(inGame && document.visibilityState === 'visible');
    });
    /* closing the tab mid-game: the last stretch is kept before the page goes */
    window.addEventListener('pagehide', function () {
      countHere(false);
      if (listTimer) {
        clearInterval(listTimer);
        listTimer = null;
      }
    });

    /* Joined from somebody's card: straight in, now that everything is wired - and into
       the server they are in, when the Hub said which one. */
    if (joinWanted && joinWanted === game.id) enter(joinServer);
  }

  function tinted(title, text) {
    var box = Hub.el('div', 'tbox');
    box.appendChild(Hub.el('h2', '', title));
    var body = Hub.el('div', 'body pre', text);
    box.appendChild(body);
    return box;
  }
}());
