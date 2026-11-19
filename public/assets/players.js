/*
 * Everyone here, and players.html#<login> for one person.
 *
 * A profile is one wide header card - picture, name, @login, what they are up to and
 * two or three numbers - and then what they have made, stacked under it. Favourites
 * are private, so that row only ever appears on your own profile.
 */
(function () {
  'use strict';
  var listView = document.getElementById('listView');
  var profileView = document.getElementById('profileView');
  var people = document.getElementById('people');
  var hub = null;

  Hub.bar('players', null);

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
    document.title = 'Players · Hub';
    var members = hub.members || [];
    document.getElementById('count').textContent = 'Players (' + members.length + ')';
    Hub.clear(people);
    if (!members.length) {
      people.appendChild(Hub.el('p', 'muted', 'Nobody has joined yet.'));
      return;
    }
    var games = published();
    people.className = 'people-grid' + (members.length <= 6 ? ' people-big' : '');
    Hub.sortPeople(members).forEach(function (m) {
      people.appendChild(Hub.personCard(m, games, hub.me));
    });
  }

  function num(host, value, label) {
    var cell = Hub.el('div', 'pro-num');
    cell.appendChild(Hub.el('div', 'v', String(value)));
    cell.appendChild(Hub.el('div', 'k', label));
    host.appendChild(cell);
  }

  function showProfile(login) {
    var m = Hub.memberOf(hub.members, login);
    if (!m) { showList(); return; }
    Hub.show(listView, false);
    Hub.show(profileView, true);
    document.title = (m.name || m.login) + ' · Hub';
    var isMe = Boolean(hub.me && hub.me.login === m.login);
    var ctx = { me: hub.me };
    var list = gamesOf(m.login);

    document.getElementById('pAv').src = Hub.avatarUrl(m.avatar, m.id);
    document.getElementById('pName').textContent = m.name || m.login;

    /* @login, straight to their GitHub */
    var meta = document.getElementById('pMeta');
    Hub.clear(meta);
    var url = Hub.profileUrl(m.login);
    if (url) {
      var link = Hub.el('a', '', '@' + m.login);
      link.href = url;
      link.rel = 'noopener noreferrer';
      link.target = '_blank';
      meta.appendChild(link);
    } else {
      meta.appendChild(Hub.el('span', '', '@' + m.login));
    }

    var pres = document.getElementById('pPresence');
    Hub.clear(pres);
    pres.className = 'pres-row';
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
    /* in a game right now, and not me: a way straight in beside the line */
    var inGame = Hub.joinableGame(m, published());
    if (inGame && !isMe) {
      var join = Hub.joinButton(inGame.id);
      join.setAttribute('aria-label', 'Join ' + (m.name || m.login) +
        ' in ' + (inGame.title || 'their game'));
      pres.appendChild(join);
    }

    var acts = document.getElementById('pActs');
    Hub.clear(acts);
    if (isMe) {
      var mine = Hub.el('a', 'btn btn--grey btn--sm', 'Edit my games');
      mine.href = '/mygames.html';
      acts.appendChild(mine);
    }

    var nums = document.getElementById('pNums');
    Hub.clear(nums);
    num(nums, list.length, list.length === 1 ? 'Game shared' : 'Games shared');
    num(nums, Hub.compact(list.reduce(function (n, g) { return n + (g.visits || 0); }, 0)), 'Visits');
    num(nums, Hub.monthYear(m.joined) || '—', 'Joined');

    /* their GitHub bio, as plain text - no box around nothing */
    var bio = document.getElementById('pBio');
    bio.textContent = m.bio || '';
    Hub.show(bio, Boolean(m.bio));

    var pg = document.getElementById('pGames');
    Hub.clear(pg);
    pg.className = 'grid ' + Hub.sizeFor(list.length);
    document.getElementById('pEmpty').textContent = list.length
      ? ''
      : (isMe
        ? 'You have not shared a game yet. Add one from My games and press Publish.'
        : (m.name || m.login) + ' has not shared a game yet.');
    list.forEach(function (g) { pg.appendChild(Hub.thumb(g, hub.members, ctx)); });

    /* favourites are private: your own profile only, never anybody else's */
    var ids = isMe ? ((hub.me && hub.me.favorites) || []) : [];
    var favs = [];
    ids.forEach(function (id) {
      published().forEach(function (g) { if (g.id === id) favs.push(g); });
    });
    Hub.show('favBox', isMe && favs.length > 0);
    var pf = document.getElementById('pFavs');
    Hub.clear(pf);
    pf.className = 'grid ' + Hub.sizeFor(favs.length);
    favs.forEach(function (g) { pf.appendChild(Hub.thumb(g, hub.members, ctx)); });
  }

  function route() {
    var h = '';
    try { h = decodeURIComponent(location.hash.replace(/^#/, '')); } catch (e) { h = ''; }
    if (h && /^[A-Za-z0-9-]{1,39}$/.test(h)) showProfile(h); else showList();
  }

  window.addEventListener('hashchange', route);
}());
