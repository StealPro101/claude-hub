/*
 * Shared front end. No inline script or style anywhere on the Hub (the
 * Content-Security-Policy allows neither), and nothing a member typed is ever written
 * as HTML - it goes in through textContent.
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

  function show(node, on) {
    if (typeof node === 'string') node = document.getElementById(node);
    if (node) node.classList.toggle('off', !on);
  }

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

  /* Covers are served by the Hub itself and nowhere else. */
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

  /* No picture? Set the title big on one of ten hand-picked colour pairs. */
  function coverNode(game) {
    var box = el('span', 'cover');
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
    box.className = 'cover cover-gen gen-' + (hashOf(game && game.id) % 10 + 1);
    box.appendChild(el('span', '', (game && game.title) || 'Untitled'));
    return box;
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
    var items = [['arcade', '/', 'Arcade'], ['players', '/players.html', 'Players']];
    items.push(me ? ['mygames', '/mygames.html', 'My games'] : ['signin', '/auth/login', 'Sign in']);
    items.push(['rules', '/rules.html', 'Rules']);
    if (me && me.admin) items.push(['admin', '/admin.html', 'Admin']);
    for (var i = 0; i < items.length; i++) {
      var a = el('a', items[i][0] === active ? 'on' : '', items[i][2]);
      a.href = items[i][1];
      host.appendChild(a);
    }
  }

  function strip(round) {
    var box = document.getElementById('strip');
    if (!box || !round) return;
    clear(box);
    box.appendChild(el('span', 'n', 'Round ' + (Number(round.round) || 1)));
    box.appendChild(el('span', 'c', String(round.category || 'freestyle')));
    if (round.note) box.appendChild(el('span', 'note', round.note));
    box.classList.remove('off');
  }

  function memberOf(members, login) {
    var low = String(login || '').toLowerCase();
    for (var i = 0; members && i < members.length; i++) {
      if (String(members[i].login).toLowerCase() === low) return members[i];
    }
    return null;
  }

  function makerLine(game, members) {
    var m = memberOf(members, game.owner);
    var by = el('span', 'by');
    var img = document.createElement('img');
    img.src = avatarUrl(m && m.avatar, m && m.id);
    img.alt = '';
    img.loading = 'lazy';
    by.appendChild(img);
    by.appendChild(el('span', '', game.owner));
    return by;
  }

  /* One card, used on the arcade grid and on a profile. */
  function gameCard(game, members) {
    var card = el('a', 'card');
    card.href = '/play.html?g=' + encodeURIComponent(game.id);
    card.appendChild(coverNode(game));
    card.appendChild(el('h3', '', game.title || 'Untitled'));
    var foot = el('div', 'card-foot');
    foot.appendChild(makerLine(game, members));
    if (game.status === 'draft') foot.appendChild(el('span', 'tag-draft', 'draft'));
    else foot.appendChild(el('span', 'cat', game.house ? 'house' : (game.category || 'freestyle')));
    card.appendChild(foot);
    return card;
  }

  function fail(host, message) {
    if (!host) return;
    clear(host);
    host.appendChild(el('p', 'dim', message));
  }

  purgeOldSecrets();

  return {
    el: el, clear: clear, show: show, data: data, post: post, nav: nav, strip: strip,
    gameCard: gameCard, coverNode: coverNode, coverUrl: coverUrl, makerLine: makerLine,
    memberOf: memberOf, playUrl: playUrl, avatarUrl: avatarUrl, profileUrl: profileUrl,
    ago: ago, fail: fail, hashOf: hashOf, lsGet: lsGet, lsSet: lsSet
  };
}());
