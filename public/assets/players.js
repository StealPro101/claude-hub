/* The crew, and players.html#<login> for one person. Drafts are nobody else's business. */
(function () {
  'use strict';
  var members = [], games = [];
  var listView = document.getElementById('listView');
  var profileView = document.getElementById('profileView');
  var people = document.getElementById('people');

  Hub.nav('players', null);

  Hub.data().then(function (d) {
    members = Array.isArray(d.members) ? d.members : [];
    games = Array.isArray(d.games) ? d.games : [];
    Hub.nav('players', d.me);
    route();
  }).catch(function () {
    Hub.fail(people, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function gamesOf(login) {
    var low = String(login).toLowerCase();
    return games.filter(function (g) {
      return String(g.owner).toLowerCase() === low && g.status !== 'draft';
    });
  }

  function showList() {
    Hub.show(profileView, false);
    Hub.show(listView, true);
    document.getElementById('count').textContent = members.length
      ? members.length + (members.length === 1 ? ' person' : ' people') + ' on the Hub'
      : '';
    Hub.clear(people);
    if (!members.length) {
      people.appendChild(Hub.el('p', 'dim', 'Nobody has joined yet.'));
      return;
    }
    for (var i = 0; i < members.length; i++) {
      (function (m) {
        var a = Hub.el('a', 'person');
        a.href = '/players.html#' + encodeURIComponent(m.login);
        var img = document.createElement('img');
        img.src = Hub.avatarUrl(m.avatar, m.id);
        img.alt = '';
        img.loading = 'lazy';
        a.appendChild(img);
        var box = Hub.el('span');
        box.appendChild(Hub.el('span', 'n', m.name || m.login));
        var n = gamesOf(m.login).length;
        box.appendChild(Hub.el('span', 's', n + (n === 1 ? ' game' : ' games')));
        a.appendChild(box);
        people.appendChild(a);
      }(members[i]));
    }
  }

  function showProfile(login) {
    var m = Hub.memberOf(members, login);
    if (!m) { showList(); return; }
    Hub.show(listView, false);
    Hub.show(profileView, true);
    document.getElementById('pAv').src = Hub.avatarUrl(m.avatar, m.id);
    document.getElementById('pName').textContent = m.name || m.login;
    var loginEl = document.getElementById('pLogin');
    Hub.clear(loginEl);
    var url = Hub.profileUrl(m.login);
    if (url) {
      var link = Hub.el('a', '', '@' + m.login + ' on GitHub');
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
      list.length + (list.length === 1 ? ' game' : ' games') +
      (m.joined ? ' · joined ' + m.joined : '');
    var pg = document.getElementById('pGames');
    Hub.clear(pg);
    document.getElementById('pEmpty').textContent = list.length
      ? '' : 'Nothing published yet.';
    for (var j = 0; j < list.length; j++) pg.appendChild(Hub.gameCard(list[j], members));
  }

  function route() {
    var h = '';
    try { h = decodeURIComponent(location.hash.replace(/^#/, '')); } catch (e) { h = ''; }
    if (h && /^[A-Za-z0-9-]{1,39}$/.test(h)) showProfile(h); else showList();
  }

  window.addEventListener('hashchange', route);
}());
