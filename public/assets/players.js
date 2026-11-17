/* Everyone here, and players.html#<login> for one person. */
(function () {
  'use strict';
  var listView = document.getElementById('listView');
  var profileView = document.getElementById('profileView');
  var people = document.getElementById('people');
  var hub = null;

  Hub.bar('players', null);
  Hub.footer();

  Hub.data().then(function (d) {
    hub = d;
    Hub.bar('players', d);
    Hub.beat(null);
    route();
  }).catch(function () {
    Hub.fail(people, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function published() {
    return (hub.games || []).filter(function (g) { return g.status !== 'draft'; });
  }

  function gamesOf(login) {
    var low = String(login).toLowerCase();
    return published().filter(function (g) { return String(g.owner).toLowerCase() === low; });
  }

  function showList() {
    Hub.show(profileView, false);
    Hub.show(listView, true);
    var members = hub.members || [];
    document.getElementById('count').textContent =
      'Players (' + members.length + ')';
    Hub.clear(people);
    if (!members.length) {
      people.appendChild(Hub.el('p', 'muted', 'Nobody has joined yet.'));
      return;
    }
    var games = published();
    Hub.sortPeople(members).forEach(function (m) {
      people.appendChild(Hub.personCard(m, games));
    });
  }

  function showProfile(login) {
    var m = Hub.memberOf(hub.members, login);
    if (!m) { showList(); return; }
    Hub.show(listView, false);
    Hub.show(profileView, true);
    document.title = (m.name || m.login) + ' · Hub';

    document.getElementById('pAv').src = Hub.avatarUrl(m.avatar, m.id);
    document.getElementById('pName').textContent = m.name || m.login;

    var meta = document.getElementById('pMeta');
    Hub.clear(meta);
    var link = Hub.el('a', '', '@' + m.login);
    var url = Hub.profileUrl(m.login);
    if (url) {
      link.href = url;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      meta.appendChild(link);
      meta.appendChild(document.createTextNode(' · '));
    }
    meta.appendChild(document.createTextNode('joined ' + (Hub.monthYear(m.joined) || m.joined || '')));

    var pres = document.getElementById('pPresence');
    Hub.clear(pres);
    var p = Hub.presenceText(m, published());
    var line = Hub.el('span', 'presence-line ' + p.dot);
    line.appendChild(Hub.el('i', 'dot'));
    if (p.game) {
      var a = Hub.el('a', '', p.text);
      a.href = '/play.html?g=' + encodeURIComponent(p.game);
      line.appendChild(a);
    } else {
      line.appendChild(Hub.el('span', '', p.text));
    }
    pres.appendChild(line);

    var acts = document.getElementById('pActs');
    Hub.clear(acts);
    if (hub.me && hub.me.login === m.login) {
      acts.appendChild(Hub.el('span', 'pill pill-live', 'this is you'));
      var mine = Hub.el('a', 'btn btn--grey btn--sm', 'My games');
      mine.href = '/mygames.html';
      acts.appendChild(mine);
    }

    document.getElementById('pBio').textContent = m.bio || 'Nothing here yet.';
    var list = gamesOf(m.login);
    document.getElementById('pStats').textContent =
      Hub.count(list.length, 'game') + ' shared · ' +
      Hub.count(list.reduce(function (n, g) { return n + (g.loves || 0); }, 0), 'love');

    var pg = document.getElementById('pGames');
    Hub.clear(pg);
    document.getElementById('pEmpty').textContent = list.length ? '' : 'Nothing shared yet.';
    list.forEach(function (g) { pg.appendChild(Hub.thumb(g, hub.members)); });

    var lovedIds = m.loved || [];
    var loved = published().filter(function (g) { return lovedIds.indexOf(g.id) >= 0; });
    Hub.show('lovedBox', loved.length > 0);
    var pl = document.getElementById('pLoved');
    Hub.clear(pl);
    loved.forEach(function (g) { pl.appendChild(Hub.thumb(g, hub.members)); });
  }

  function route() {
    var h = '';
    try { h = decodeURIComponent(location.hash.replace(/^#/, '')); } catch (e) { h = ''; }
    if (h && /^[A-Za-z0-9-]{1,39}$/.test(h)) showProfile(h); else showList();
  }

  window.addEventListener('hashchange', route);
}());
