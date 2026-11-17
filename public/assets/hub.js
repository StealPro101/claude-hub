/*
 * Shared front end. No inline script anywhere on the Hub (the Content-Security-Policy
 * only allows the site's own files), and nothing a member typed is ever written as
 * HTML - it goes in through textContent.
 */
var Hub = (function () {
  'use strict';

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* blocked storage */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* blocked storage */ } }

  /* v2 kept a shared upload token and PIN hashes in the browser. v3 has no secrets at
     all, so clear anything left over in a friend's browser, once. */
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

  var ICONS = ['🎮', '👾', '🚀', '🧩', '🎯', '💥'];
  function iconFor(seed) {
    var h = 0, s = String(seed || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return ICONS[h % ICONS.length];
  }

  function avatarUrl(url, id) {
    if (typeof url === 'string' && url.indexOf('https://avatars.githubusercontent.com/') === 0) return url;
    return 'https://avatars.githubusercontent.com/u/' + (Number(id) || 0) + '?v=4';
  }

  function profileUrl(login) {
    return /^[A-Za-z0-9-]{1,39}$/.test(String(login)) ? 'https://github.com/' + login : null;
  }

  /* A game's play address is only ever the one the server computed from its owner -
     house games included, they just live one folder deeper on the owner's Pages site. */
  function playUrl(game) {
    if (!game || typeof game.url !== 'string') return null;
    if (!/^[A-Za-z0-9-]{1,39}$/.test(String(game.owner || ''))) return null;
    var want = 'https://' + String(game.owner).toLowerCase() + '.github.io/';
    return game.url.indexOf(want) === 0 ? game.url : null;
  }

  function ago(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!t) return '';
    var s = Math.max(1, Math.floor((Date.now() - t) / 1000));
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
    if (s < 86400 * 365) return Math.floor(s / (86400 * 30)) + 'mo ago';
    return Math.floor(s / (86400 * 365)) + 'y ago';
  }

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

  function nav(active, me) {
    var host = document.getElementById('nav');
    if (!host) return;
    host.className = 'nav';
    clear(host);
    var items = [['arcade', '/', '🕹️ ARCADE'], ['players', '/players.html', '👥 PLAYERS']];
    if (me) items.push(['mygames', '/mygames.html', '🎮 MY GAMES']);
    else items.push(['signin', '/auth/login', '→ SIGN IN']);
    items.push(['rules', '/rules.html', '📜 RULES']);
    if (me && me.admin) items.push(['admin', '/admin.html', '⚙️ ADMIN']);
    for (var i = 0; i < items.length; i++) {
      var a = el('a', items[i][0] === active ? 'on' : '', items[i][2]);
      a.href = items[i][1];
      host.appendChild(a);
    }
  }

  function roundBanner(round) {
    var b = document.getElementById('banner');
    if (!b || !round) return;
    var r = el('span', 'rd', 'ROUND ' + (Number(round.round) || 1));
    var c = el('span', 'cat', String(round.category || 'freestyle').toUpperCase());
    var n = el('span', 'note', round.note || '');
    clear(b);
    b.appendChild(r);
    b.appendChild(c);
    b.appendChild(n);
    b.classList.remove('off');
  }

  function gameCard(game, members) {
    var card = el('div', 'card');
    var top = el('div', 'card-top', game.emoji || iconFor(game.id));
    card.appendChild(top);
    var body = el('div', 'card-body');
    body.appendChild(el('h3', '', game.title || 'Untitled'));

    var meta = el('div', 'meta');
    meta.appendChild(el('span', 'badge', String(game.category || 'freestyle')));
    if (game.featured) meta.appendChild(el('span', 'flag', 'pick'));
    if (game.house) meta.appendChild(el('span', 'badge', 'house'));
    body.appendChild(meta);

    if (game.description) body.appendChild(el('div', 'desc', game.description));

    var row = el('div', 'cardrow');
    var by = el('div', 'by');
    var m = null;
    for (var i = 0; members && i < members.length; i++) {
      if (String(members[i].login).toLowerCase() === String(game.owner).toLowerCase()) m = members[i];
    }
    var img = document.createElement('img');
    img.src = avatarUrl(m && m.avatar, m && m.id);
    img.alt = '';
    img.loading = 'lazy';
    by.appendChild(img);
    var who = el('a', '', '@' + game.owner);
    var pu = profileUrl(game.owner);
    if (pu) {
      who.href = pu;
      who.rel = 'noopener noreferrer';
      who.target = '_blank';
    } else {
      who = el('span', 'muted', String(game.owner || ''));
    }
    by.appendChild(who);
    row.appendChild(by);
    if (game.updated) row.appendChild(el('span', 'stars', ago(game.updated)));
    body.appendChild(row);

    var play = el('a', 'btn', '▶ PLAY');
    play.classList.add('mt-auto');
    play.href = '/play.html?g=' + encodeURIComponent(game.id);
    body.appendChild(play);
    card.appendChild(body);
    return card;
  }

  function fail(host, message) {
    if (!host) return;
    clear(host);
    host.appendChild(el('div', 'err', message));
  }

  purgeOldSecrets();

  return {
    el: el, clear: clear, data: data, post: post, nav: nav, roundBanner: roundBanner,
    gameCard: gameCard, playUrl: playUrl, avatarUrl: avatarUrl, profileUrl: profileUrl,
    iconFor: iconFor, ago: ago, fail: fail, lsGet: lsGet, lsSet: lsSet
  };
}());
