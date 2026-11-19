/*
 * Home: no name, no pitch, no headline - straight into what is yours, who is about and
 * what there is to play. Every row is a plain bold heading over a one-row carousel that
 * runs the whole width of the page.
 *
 * For a signed-in member with favourites, their own row is pinned at the very top. It
 * is private: nobody else's page ever shows it, and no count of it exists anywhere.
 */
(function () {
  'use strict';
  var main = document.getElementById('main');

  Hub.bar('home', null);

  Hub.data().then(draw).catch(function () {
    Hub.fail(main, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function draw(d) {
    Hub.bar('home', d);
    Hub.beat(null);
    var members = d.members || [];
    var games = (d.games || []).filter(function (g) { return g.status !== 'draft'; });
    var ctx = { me: d.me, onChange: function () { drawFavorites(); } };
    var favBox = null;
    Hub.clear(main);

    /* ---- mine, pinned on top ---- */
    function favorites() {
      var order = (d.me && d.me.favorites) || [];
      var out = [];
      for (var i = 0; i < order.length; i++) {
        for (var j = 0; j < games.length; j++) {
          if (games[j].id === order[i] && games[j].favorite) out.push(games[j]);
        }
      }
      return out;
    }

    function drawFavorites() {
      var list = favorites();
      if (!list.length) {
        if (favBox) {
          main.removeChild(favBox.box);
          favBox = null;
        }
        return;
      }
      if (!favBox) {
        favBox = Hub.box('Favorites', { sub: 'only you see these', tight: true, row: true });
        main.insertBefore(favBox.box, main.firstChild);
      }
      Hub.clear(favBox.body);
      favBox.body.appendChild(Hub.rail(list.map(function (g) {
        return Hub.thumb(g, members, ctx);
      }), Hub.sizeFor(list.length)));
    }

    /* who is about */
    if (members.length) {
      var people = Hub.sortPeople(members).map(function (m) { return Hub.personCard(m, games); });
      var pb = Hub.box('Players (' + members.length + ')', {
        moreHref: '/players.html', tight: true, row: true
      });
      pb.body.appendChild(Hub.rail(people, Hub.peopleSize(people.length)));
      main.appendChild(pb.box);
    }

    if (!games.length) {
      var first = Hub.box('Nothing here yet');
      var p = Hub.el('p', '', 'No games have been shared yet. Yours could be the first one.');
      first.body.appendChild(p);
      var row = Hub.el('p', 'btn-row');
      var a = Hub.el('a', 'btn', d.me ? 'Add a game' : 'Join with your link');
      a.href = d.me ? '/mygames.html' : '/join.html';
      row.appendChild(a);
      first.body.appendChild(row);
      main.appendChild(first.box);
      return;
    }

    var featured = games.filter(function (g) { return g.featured; });
    if (featured.length) addRow('Featured', featured, { moreHref: '/explore.html' });

    var round = d.round || {};
    var cat = String(round.category || '').toLowerCase();
    var ofRound = games.filter(function (g) { return String(g.category).toLowerCase() === cat; });
    if (cat && ofRound.length) {
      addRow('This round: ' + cat, ofRound, {
        sub: round.note || '',
        moreHref: '/explore.html?cat=' + encodeURIComponent(cat)
      });
    }

    var newest = games.slice().sort(function (a, b) {
      return String(b.updated || '').localeCompare(String(a.updated || ''));
    });
    addRow('Newest', newest, { moreHref: '/explore.html' });

    /* played, not liked: the only honest number a hub this small has */
    var played = games.filter(function (g) { return (g.visits || 0) > 0; })
      .sort(function (a, b) { return (b.visits || 0) - (a.visits || 0); });
    if (played.length) {
      addRow('Most played', played, { moreHref: '/explore.html?sort=played' });
    }

    drawFavorites();

    function addRow(title, list, opts) {
      var o = opts || {};
      o.tight = true;
      o.row = true;
      var b = Hub.box(title, o);
      var shown = list.slice(0, 24);
      b.body.appendChild(Hub.rail(shown.map(function (g) {
        return Hub.thumb(g, members, ctx);
      }), Hub.sizeFor(shown.length)));
      main.appendChild(b.box);
    }
  }
}());
