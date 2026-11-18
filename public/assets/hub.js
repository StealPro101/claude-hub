/*
 * The shared front end: the top bar, the footer, boxes, thumbnail rows, the little
 * drawn icons, and the heartbeat that keeps "who is playing" alive.
 *
 * No inline script or style anywhere (the Content-Security-Policy allows neither), and
 * nothing anyone typed is ever written as HTML - it goes in through textContent.
 */
var Hub = (function () {
  'use strict';

  var SVG = 'http://www.w3.org/2000/svg';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* blocked */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* blocked */ } }

  /* v2 kept a shared upload token and PIN hashes in browsers. Clear the lot, once. */
  function purgeOldSecrets() {
    if (lsGet('hubPurged') === '3') return;
    lsDel('hubToken');
    lsDel('hubMe');
    try {
      var kill = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && (k.indexOf('hubPin:') === 0 || k === 'hubCacheGames' || k === 'hubCachePlayers')) kill.push(k);
      }
      for (var j = 0; j < kill.length; j++) lsDel(kill[j]);
    } catch (e) { /* blocked storage */ }
    lsSet('hubPurged', '3');
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function show(node, on) {
    if (typeof node === 'string') node = document.getElementById(node);
    if (node) node.classList.toggle('off', !on);
  }

  /* ---------- icons, drawn here, no image files and no emoji ---------- */

  var PATHS = {
    search: ['M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM16.5 16.5 21 21', 0],
    person: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 1.8c-4.1 0-7 2-7 4.4V21h14v-2.8c0-2.4-2.9-4.4-7-4.4z', 1],
    flag: ['M6 21V4m0 1h11l-2 3.5L17 12H6', 0],
    link: ['M10 14a3.6 3.6 0 0 1 0-5l2-2a3.6 3.6 0 1 1 5 5l-1 1M14 10a3.6 3.6 0 0 1 0 5l-2 2a3.6 3.6 0 1 1-5-5l1-1', 0],
    left: ['M14.5 5.5 8 12l6.5 6.5', 0],
    right: ['M9.5 5.5 16 12l-6.5 6.5', 0],
    expand: ['M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', 0],
    close: ['M6 6l12 12M18 6 6 18', 0],
    menu: ['M4 7h16M4 12h16M4 17h16', 0],
    play: ['M8 5.2v13.6L19 12z', 1],
    check: ['M5 13l4 4L19 7', 0],
    /* the favourite star: the same shape drawn solid or as an outline */
    star: ['M12 3.4l2.72 5.52 6.09.89-4.4 4.29 1.03 6.06L12 17.33l-5.44 2.83 1.03-6.06-4.4-4.29 6.09-.89z', 1],
    starLine: ['M12 3.4l2.72 5.52 6.09.89-4.4 4.29 1.03 6.06L12 17.33l-5.44 2.83 1.03-6.06-4.4-4.29 6.09-.89z', 0]
  };

  function icon(name, size) {
    var svg = document.createElementNS(SVG, 'svg');
    var s = size || 16;
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', s);
    svg.setAttribute('height', s);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var p = document.createElementNS(SVG, 'path');
    var def = PATHS[name] || PATHS.play;
    p.setAttribute('d', def[0]);
    if (def[1]) {
      p.setAttribute('fill', 'currentColor');
    } else {
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '2');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
    }
    svg.appendChild(p);
    return svg;
  }

  /* The mark in the corner: a rounded tile with a play shape cut into it. */
  function logoMark(size) {
    var s = size || 30;
    var svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 32 32');
    svg.setAttribute('width', s);
    svg.setAttribute('height', s);
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var r = document.createElementNS(SVG, 'rect');
    r.setAttribute('x', '2');
    r.setAttribute('y', '2');
    r.setAttribute('width', '28');
    r.setAttribute('height', '28');
    r.setAttribute('rx', '9');
    r.setAttribute('fill', 'currentColor');
    svg.appendChild(r);
    var p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', 'M13 10.5v11l9-5.5z');
    p.setAttribute('fill', '#c2410c');
    svg.appendChild(p);
    var d1 = document.createElementNS(SVG, 'circle');
    d1.setAttribute('cx', '9.5');
    d1.setAttribute('cy', '16');
    d1.setAttribute('r', '1.6');
    d1.setAttribute('fill', '#c2410c');
    svg.appendChild(d1);
    return svg;
  }

  /* ---------- small helpers ---------- */

  function avatarUrl(url, id) {
    if (typeof url === 'string' && url.indexOf('https://avatars.githubusercontent.com/') === 0) return url;
    return 'https://avatars.githubusercontent.com/u/' + (Number(id) || 0) + '?v=4';
  }

  function profileUrl(login) {
    return /^[A-Za-z0-9-]{1,39}$/.test(String(login)) ? 'https://github.com/' + login : null;
  }

  /* A game's play address is only ever the one the server computed from its owner. */
  function playUrl(game) {
    if (!game || typeof game.url !== 'string') return null;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(String(game.owner || ''))) return null;
    var want = 'https://' + String(game.owner).toLowerCase() + '.github.io/';
    return game.url.indexOf(want) === 0 ? game.url : null;
  }

  function coverUrl(game) {
    var u = game && game.cover;
    return typeof u === 'string' && /^\/img\/cover\/[A-Za-z0-9]+\/[A-Za-z0-9._-]+\?v=[A-Za-z0-9]+$/.test(u)
      ? u : null;
  }

  function hashOf(seed) {
    var h = 0, s = String(seed || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h;
  }

  /* No picture? The title, set big on a flat colour. */
  function coverInto(box, game) {
    var url = coverUrl(game);
    if (url) {
      var img = document.createElement('img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      box.appendChild(img);
      return box;
    }
    var gen = el('div', 'gen gen-' + (hashOf(game && game.id) % 10 + 1));
    gen.appendChild(el('span', '', (game && game.title) || 'Untitled'));
    box.appendChild(gen);
    return box;
  }

  function ago(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!t) return '';
    var s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' days ago';
    if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + ' months ago';
    return Math.floor(s / (86400 * 365)) + ' years ago';
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceDate(iso) {
    var t = Date.parse(iso);
    if (!t) return '';
    var d = new Date(t);
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
  }
  function monthYear(iso) {
    var t = Date.parse(iso);
    if (!t) return '';
    var d = new Date(t);
    return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
  }

  function count(n, one, many) {
    var v = Number(n) || 0;
    return v + ' ' + (v === 1 ? one : (many || one + 's'));
  }

  /* ---------- data ---------- */

  var dataPromise = null;
  function data(force) {
    if (!dataPromise || force) {
      dataPromise = fetch('/api/hub', { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('hub ' + r.status);
          return r.json();
        })
        .then(function (j) {
          lsSet('hubLastGood', JSON.stringify(j));
          return j;
        })
        .catch(function (e) {
          var cached = lsGet('hubLastGood');
          if (cached) {
            try {
              var j = JSON.parse(cached);
              j.stale = true;
              return j;
            } catch (e2) { /* fall through */ }
          }
          throw e;
        });
    }
    return dataPromise;
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
    });
  }

  /* ---------- the top bar ---------- */

  function barLink(href, label, on) {
    var a = el('a', on ? 'on' : '', label);
    a.href = href;
    return a;
  }

  function bar(active, d) {
    var host = document.getElementById('bar');
    if (!host) return;
    var me = d && d.me;
    clear(host);
    host.className = 'bar';
    var inner = el('div', 'col bar-in');

    var home = el('a', 'brand');
    home.href = '/';
    home.setAttribute('aria-label', 'Home');
    home.appendChild(logoMark(30));
    inner.appendChild(home);

    var burger = el('button', 'burger');
    burger.type = 'button';
    burger.setAttribute('aria-label', 'Menu');
    burger.appendChild(icon('menu', 22));
    inner.appendChild(burger);

    var links = el('nav', 'bar-links');
    links.setAttribute('aria-label', 'Main');
    links.appendChild(barLink('/explore.html', 'Explore', active === 'explore'));
    links.appendChild(barLink('/players.html', 'Players', active === 'players'));
    links.appendChild(barLink('/rules.html', 'Rules', active === 'rules'));
    inner.appendChild(links);
    burger.addEventListener('click', function () { links.classList.toggle('open'); });

    var form = el('form', 'bar-search');
    form.action = '/explore.html';
    form.method = 'get';
    var q = document.createElement('input');
    q.type = 'search';
    q.name = 'q';
    q.placeholder = 'Search games';
    q.setAttribute('aria-label', 'Search games');
    try {
      var hadQ = new URLSearchParams(location.search).get('q');
      if (hadQ) q.value = hadQ;
    } catch (e) { /* no query */ }
    form.appendChild(q);
    var go = el('button', '');
    go.type = 'submit';
    go.setAttribute('aria-label', 'Search');
    go.appendChild(icon('search', 15));
    form.appendChild(go);
    inner.appendChild(form);

    var right = el('div', 'bar-right');
    if (!me) {
      var join = el('a', 'btn btn--sm', 'Join');
      join.href = '/join.html';
      right.appendChild(join);
      var sin = el('a', 'join', 'Sign in');
      sin.href = '/auth/login';
      right.appendChild(sin);
    } else {
      var member = memberOf(d.members, me.login);
      var btn = el('button', 'who-btn');
      btn.type = 'button';
      btn.setAttribute('aria-haspopup', 'true');
      btn.setAttribute('aria-expanded', 'false');
      var img = document.createElement('img');
      img.src = avatarUrl(member && member.avatar, me.id);
      img.alt = '';
      btn.appendChild(img);
      btn.appendChild(el('span', '', me.login));
      btn.appendChild(el('span', 'caret'));
      right.appendChild(btn);

      var drafts = (d.games || []).filter(function (g) {
        return g.status === 'draft' && g.owner === me.login;
      }).length;

      var menu = el('div', 'menu off');
      var mg = el('a', '', 'My games');
      mg.href = '/mygames.html';
      if (drafts) {
        mg.appendChild(el('span', 'badge', drafts + (drafts === 1 ? ' draft' : ' drafts')));
      }
      menu.appendChild(mg);
      var mp = el('a', '', 'My profile');
      mp.href = '/players.html#' + encodeURIComponent(me.login);
      menu.appendChild(mp);
      if (me.admin) {
        var ad = el('a', '', 'Admin');
        ad.href = '/admin.html';
        menu.appendChild(ad);
      }
      menu.appendChild(el('hr'));
      var out = el('button', '', 'Sign out');
      out.type = 'button';
      out.addEventListener('click', function () {
        post('/auth/logout', {}).then(function () { location.href = '/'; });
      });
      menu.appendChild(out);
      host.appendChild(menu);

      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var open = menu.classList.toggle('off');
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
      });
      document.addEventListener('click', function () {
        menu.classList.add('off');
        btn.setAttribute('aria-expanded', 'false');
      });
    }
    inner.appendChild(right);
    host.appendChild(inner);
  }

  function footer() {
    var host = document.getElementById('foot');
    if (!host) return;
    clear(host);
    var inner = el('div', 'col foot-in');
    var about = el('div', 'about');
    about.appendChild(el('h3', '', 'About'));
    about.appendChild(el('p', '',
      'A small arcade for a few friends. Everyone makes games and everyone plays them.'));
    about.appendChild(el('p', 'foot-note',
      'Games run on their makers’ own pages. Nobody here checks their code, so play at your own risk.'));
    inner.appendChild(about);

    var links = el('div', 'foot-col');
    links.appendChild(el('h3', '', 'Around here'));
    [['/explore.html', 'Explore'], ['/players.html', 'Players'],
      ['/rules.html', 'Rules'], ['/join.html', 'Join']].forEach(function (pair) {
      var a = el('a', '', pair[1]);
      a.href = pair[0];
      links.appendChild(a);
    });
    inner.appendChild(links);
    host.appendChild(inner);
  }

  /* ---------- boxes and rows ---------- */

  function box(title, opts) {
    var o = opts || {};
    var wrap = el('section', 'box');
    var head = el('div', 'box-head');
    head.appendChild(el('h2', '', title));
    if (o.sub) head.appendChild(el('span', 'sub', o.sub));
    if (o.moreHref) {
      var a = el('a', 'more', o.moreText || 'See all');
      a.href = o.moreHref;
      head.appendChild(a);
    }
    wrap.appendChild(head);
    var body = el('div', 'box-body' + (o.tight ? ' tight' : ''));
    wrap.appendChild(body);
    return { box: wrap, body: body, head: head };
  }

  /* A single row that scrolls sideways, with a round button at each end. */
  function rail(items) {
    var wrap = el('div', 'rail');
    var track = el('div', 'rail-track');
    for (var i = 0; i < items.length; i++) track.appendChild(items[i]);
    wrap.appendChild(track);

    var prev = el('button', 'rail-btn prev');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'Scroll left');
    prev.appendChild(icon('left', 16));
    var next = el('button', 'rail-btn next');
    next.type = 'button';
    next.setAttribute('aria-label', 'Scroll right');
    next.appendChild(icon('right', 16));
    wrap.appendChild(prev);
    wrap.appendChild(next);

    function step(dir) {
      track.scrollLeft += dir * Math.max(160, track.clientWidth * 0.8);
      setTimeout(update, 320);
    }
    function update() {
      var room = track.scrollWidth - track.clientWidth > 4;
      prev.hidden = !room || track.scrollLeft < 8;
      next.hidden = !room || track.scrollLeft > track.scrollWidth - track.clientWidth - 8;
    }
    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });
    track.addEventListener('scroll', function () {
      if (track._t) return;
      track._t = requestAnimationFrame(function () {
        track._t = 0;
        update();
      });
    }, { passive: true });
    window.addEventListener('resize', update);
    setTimeout(update, 60);
    return wrap;
  }

  function memberOf(members, login) {
    var low = String(login || '').toLowerCase();
    for (var i = 0; members && i < members.length; i++) {
      if (String(members[i].login).toLowerCase() === low) return members[i];
    }
    return null;
  }

  /* ---------- favourites ----------
   *
   * Private and uncounted: a star that only says whether this game is on YOUR list.
   * Nothing on the page ever shows how many people starred anything, because nothing
   * anywhere knows.
   */

  function starIcon(on, size) {
    return icon(on ? 'star' : 'starLine', size || 15);
  }

  /*
   * The small star in the corner of a thumbnail. ctx: { me, onChange }.
   * Returns null when nobody is signed in, or for a draft - there is nothing to star.
   */
  function cornerStar(game, ctx) {
    var me = ctx && ctx.me;
    if (!me || game.status === 'draft') return null;
    var btn = el('button', 'fav' + (game.favorite ? ' on' : ''));
    btn.type = 'button';
    paint(btn, game.favorite);
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      toggle(game, btn, ctx);
    });
    return btn;
  }

  function paint(btn, on) {
    clear(btn);
    btn.appendChild(starIcon(on, 15));
    btn.classList.toggle('on', Boolean(on));
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'In your favourites' : 'Add to your favourites';
    btn.setAttribute('aria-label', (on ? 'Remove from favourites: ' : 'Add to favourites: ') +
      (btn._title || ''));
  }

  function toggle(game, btn, ctx) {
    var want = !game.favorite;
    btn.disabled = true;
    return post('/api/games/favorite', { id: game.id, on: want }).then(function (r) {
      btn.disabled = false;
      if (!r || !r.ok) return;
      game.favorite = Boolean(r.favorite);
      paint(btn, game.favorite);
      if (ctx && ctx.onChange) ctx.onChange(game);
    });
  }

  /* ---------- a game thumbnail ---------- */

  function thumb(game, members, ctx) {
    var wrap = el('div', 'thumb');
    var shot = el('a', 'shot');
    shot.href = '/play.html?g=' + encodeURIComponent(game.id);
    shot.setAttribute('aria-label', game.title || 'Untitled');
    coverInto(shot, game);
    if (game.status === 'draft') shot.appendChild(el('span', 'flag', 'Draft'));
    else if (game.featured) shot.appendChild(el('span', 'flag', 'Pick'));
    wrap.appendChild(shot);
    var star = cornerStar(game, ctx);
    if (star) {
      star._title = game.title || 'Untitled';
      paint(star, game.favorite);
      wrap.appendChild(star);
    }

    var t = el('a', 't', game.title || 'Untitled');
    t.href = '/play.html?g=' + encodeURIComponent(game.id);
    wrap.appendChild(t);

    var by = el('div', 'by');
    var who = el('a', '', game.owner);
    who.href = '/players.html#' + encodeURIComponent(game.owner);
    by.appendChild(who);
    wrap.appendChild(by);

    /* the only number on a card: how many people are in there right now */
    if (game.active > 0) {
      var stats = el('div', 'pl');
      stats.appendChild(icon('person', 12));
      stats.appendChild(el('span', '', game.active + ' playing'));
      wrap.appendChild(stats);
    }
    return wrap;
  }

  /* ---------- a person, with what they are up to ---------- */

  function presenceText(member, games) {
    var p = (member && member.presence) || { state: 'offline' };
    if (p.state === 'playing') {
      var g = null;
      for (var i = 0; games && i < games.length; i++) if (games[i].id === p.game) g = games[i];
      return { dot: 'playing', text: 'Playing ' + (g ? g.title : 'a game'), game: p.game };
    }
    if (p.state === 'online') return { dot: 'online', text: 'Online' };
    return { dot: 'offline', text: p.lastSeen ? 'Offline · ' + ago(p.lastSeen) : 'Offline' };
  }

  function personCard(member, games) {
    var wrap = el('div', 'person');
    var a = el('a', '');
    a.href = '/players.html#' + encodeURIComponent(member.login);
    var img = document.createElement('img');
    img.src = avatarUrl(member.avatar, member.id);
    img.alt = '';
    img.loading = 'lazy';
    a.appendChild(img);
    a.appendChild(el('span', 'n', member.name || member.login));
    wrap.appendChild(a);
    var p = presenceText(member, games);
    var line = el('span', 's ' + p.dot);
    line.appendChild(el('i', 'dot'));
    line.appendChild(el('span', '', p.text));
    wrap.appendChild(line);
    return wrap;
  }

  function sortPeople(members) {
    var rank = { playing: 0, online: 1, offline: 2 };
    return members.slice().sort(function (a, b) {
      var ra = rank[(a.presence || {}).state] != null ? rank[(a.presence || {}).state] : 2;
      var rb = rank[(b.presence || {}).state] != null ? rank[(b.presence || {}).state] : 2;
      return ra - rb || String(a.login).localeCompare(String(b.login));
    });
  }

  /* ---------- the heartbeat ---------- */

  function token() {
    var t = lsGet('hubTab');
    if (!t) {
      t = 'g' + Math.random().toString(36).slice(2, 12);
      lsSet('hubTab', t);
    }
    return t;
  }

  /*
   * One beat on load and then every 45 seconds, but only while the tab is actually
   * being looked at, plus one "I am off" on the way out.
   */
  function beat(gameId) {
    var payload = { game: gameId || null, token: token() };
    var timer = null;

    function send() {
      if (document.visibilityState === 'hidden') return Promise.resolve();
      return fetch('/api/presence/beat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function () { /* counts are never worth an error */ });
    }

    send();
    timer = setInterval(send, 45000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') send();
    });
    window.addEventListener('pagehide', function () {
      try {
        var body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        navigator.sendBeacon('/api/presence/leave', body);
      } catch (e) { /* leaving anyway */ }
      if (timer) clearInterval(timer);
    });
    return {
      where: function (id) {
        payload.game = id || null;
        return send();
      }
    };
  }

  function fail(host, message) {
    if (!host) return;
    clear(host);
    host.appendChild(el('p', 'muted', message));
  }

  purgeOldSecrets();

  return {
    el: el, clear: clear, show: show, icon: icon, logoMark: logoMark,
    data: data, post: post, bar: bar, footer: footer, box: box, rail: rail,
    thumb: thumb, personCard: personCard, presenceText: presenceText, sortPeople: sortPeople,
    starIcon: starIcon, favoriteToggle: toggle, paintStar: paint,
    coverInto: coverInto, coverUrl: coverUrl, playUrl: playUrl, avatarUrl: avatarUrl,
    profileUrl: profileUrl, memberOf: memberOf, ago: ago, niceDate: niceDate,
    monthYear: monthYear, count: count, hashOf: hashOf, beat: beat, fail: fail,
    lsGet: lsGet, lsSet: lsSet
  };
}());
