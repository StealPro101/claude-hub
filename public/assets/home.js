/*
 * Home: no name, no pitch, no headline - straight into who is about and what there is
 * to play. Every row is a box with a header strip and a one-row carousel inside.
 */
(function () {
  'use strict';
  var main = document.getElementById('main');

  Hub.bar('home', null);
  Hub.footer();

  Hub.data().then(draw).catch(function () {
    Hub.fail(main, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function draw(d) {
    Hub.bar('home', d);
    Hub.beat(null);
    var members = d.members || [];
    var games = (d.games || []).filter(function (g) { return g.status !== 'draft'; });
    Hub.clear(main);

    /* who is about */
    if (members.length) {
      var people = Hub.sortPeople(members).map(function (m) { return Hub.personCard(m, games); });
      var pb = Hub.box('Players (' + members.length + ')', {
        moreHref: '/players.html', tight: true
      });
      pb.body.appendChild(Hub.rail(people));
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

    var loved = games.filter(function (g) { return (g.loves || 0) > 0; })
      .sort(function (a, b) { return (b.loves || 0) - (a.loves || 0); });
    if (loved.length) {
      addRow('Most loved', loved, { moreHref: '/explore.html?sort=loved' });
    }

    function addRow(title, list, opts) {
      var o = opts || {};
      o.tight = true;
      var b = Hub.box(title, o);
      b.body.appendChild(Hub.rail(list.slice(0, 24).map(function (g) {
        return Hub.thumb(g, members);
      })));
      main.appendChild(b.box);
    }
  }
}());
