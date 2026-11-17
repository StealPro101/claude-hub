/* The crew: a grid of members, and players.html#<login> for one profile. */
(function () {
  'use strict';
  var members = [], games = [];
  var listView = document.getElementById('listView');
  var profileView = document.getElementById('profileView');
  var grid = document.getElementById('grid');

  Hub.nav('players', null);

  Hub.data().then(function (d) {
    members = Array.isArray(d.members) ? d.members : [];
    games = Array.isArray(d.games) ? d.games : [];
    Hub.nav('players', d.me);
    route();
  }).catch(function () {
    Hub.fail(grid, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function gamesOf(login) {
    var low = String(login).toLowerCase();
    return games.filter(function (g) { return String(g.owner).toLowerCase() === low; });
  }

  function showList() {
    profileView.classList.add('off');
    listView.classList.remove('off');
    document.getElementById('count').textContent = members.length
      ? members.length + (members.length === 1 ? ' PLAYER' : ' PLAYERS') : '';
    Hub.clear(grid);
    if (!members.length) {
      grid.appendChild(Hub.el('div', 'empty', 'Nobody has joined yet.'));
      return;
    }
    for (var i = 0; i < members.length; i++) {
      (function (m) {
        var card = Hub.el('div', 'card mcard');
        var img = document.createElement('img');
        img.src = Hub.avatarUrl(m.avatar, m.id);
        img.alt = '';
        img.loading = 'lazy';
        card.appendChild(img);
        var box = Hub.el('div');
        box.appendChild(Hub.el('div', 'pname', m.name || m.login));
        box.appendChild(Hub.el('div', 'pstats', '@' + m.login));
        var n = gamesOf(m.login).length;
        box.appendChild(Hub.el('div', 'pstats', n + (n === 1 ? ' game' : ' games')));
        var a = Hub.el('a', 'btn alt sm', 'profile');
        a.href = '/players.html#' + encodeURIComponent(m.login);
        a.classList.add('mt-s');
        box.appendChild(a);
        card.appendChild(box);
        grid.appendChild(card);
      }(members[i]));
    }
  }

  function showProfile(login) {
    var low = String(login).toLowerCase();
    var m = null;
    for (var i = 0; i < members.length; i++) {
      if (String(members[i].login).toLowerCase() === low) m = members[i];
    }
    if (!m) { showList(); return; }
    listView.classList.add('off');
    profileView.classList.remove('off');
    document.getElementById('pAv').src = Hub.avatarUrl(m.avatar, m.id);
    document.getElementById('pName').textContent = m.name || m.login;
    var loginEl = document.getElementById('pLogin');
    Hub.clear(loginEl);
    var link = Hub.el('a', '', '@' + m.login + ' on GitHub');
    var url = Hub.profileUrl(m.login);
    if (url) {
      link.href = url;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      loginEl.appendChild(link);
    } else {
      loginEl.textContent = '@' + m.login;
    }
    document.getElementById('pBio').textContent = m.bio || '';
    var list = gamesOf(m.login);
    document.getElementById('pStats').textContent =
      list.length + (list.length === 1 ? ' game' : ' games') + ' in the arcade' +
      (m.joined ? ' · joined ' + m.joined : '');
    var pg = document.getElementById('pGames');
    Hub.clear(pg);
    if (!list.length) {
      pg.appendChild(Hub.el('div', 'empty', 'No games from ' + (m.name || m.login) + ' yet.'));
      return;
    }
    for (var j = 0; j < list.length; j++) pg.appendChild(Hub.gameCard(list[j], members));
  }

  function route() {
    var h = '';
    try { h = decodeURIComponent(location.hash.replace(/^#/, '')); } catch (e) { h = ''; }
    if (h && /^[A-Za-z0-9-]{1,39}$/.test(h)) showProfile(h); else showList();
  }

  window.addEventListener('hashchange', route);
}());
