/*
 * Charts: the same games as everywhere else, in the orders that say something -
 * most visited, who is being played right now, newest, the owner's picks, and the
 * best of each category. One ranking per row, numbered from 1, ten at most.
 *
 * A chart only ever holds a few lines, so the tiles are one size step bigger than
 * the usual rule gives them.
 */
(function () {
  'use strict';
  var main = document.getElementById('main');

  Hub.bar('charts', null);

  Hub.data().then(draw).catch(function () {
    Hub.fail(main, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  /* one step bigger than Hub.sizeFor, because a chart is never a long shelf */
  function chartSize(n) {
    return n <= 6 ? 'size-xl' : 'size-lg';
  }

  function draw(d) {
    Hub.bar('charts', d);
    Hub.beat(null);
    var members = d.members || [];
    var games = (d.games || []).filter(function (g) { return g.status !== 'draft'; });
    var ctx = { me: d.me };
    Hub.clear(main);
    main.appendChild(Hub.el('h1', 'page-title', 'Charts'));

    if (!games.length) {
      var none = Hub.box('Nothing to rank yet');
      none.body.appendChild(Hub.el('p', '',
        'No games have been shared yet, so there is nothing to put in order.'));
      var row = Hub.el('p', 'btn-row');
      var a = Hub.el('a', 'btn', d.me ? 'Add a game' : 'Join with your link');
      a.href = d.me ? '/mygames.html' : '/join.html';
      row.appendChild(a);
      none.body.appendChild(row);
      main.appendChild(none.box);
      return;
    }

    var visited = games.filter(function (g) { return (g.visits || 0) > 0; })
      .sort(function (a, b) { return (b.visits || 0) - (a.visits || 0); });
    chart('Most visited', visited, '/explore.html?sort=played');

    var playing = games.filter(function (g) { return (g.active || 0) > 0; })
      .sort(function (a, b) { return (b.active || 0) - (a.active || 0); });
    chart('Playing right now', playing, null);

    var newest = games.slice().sort(function (a, b) {
      return String(b.updated || '').localeCompare(String(a.updated || ''));
    });
    chart('Newest', newest, '/explore.html?sort=new');

    chart('Picks', games.filter(function (g) { return g.featured; }), null);

    /* a category earns a row of its own once two games are in it */
    var cats = [];
    games.forEach(function (g) {
      var c = String(g.category || 'freestyle');
      if (cats.indexOf(c) < 0) cats.push(c);
    });
    cats.sort();
    cats.forEach(function (c) {
      var list = games.filter(function (g) { return String(g.category || 'freestyle') === c; })
        .sort(function (a, b) { return (b.visits || 0) - (a.visits || 0); });
      if (list.length < 2) return;
      chart('Top ' + c, list, '/explore.html?cat=' + encodeURIComponent(c));
    });

    var all = Hub.el('p', 'btn-row charts-all');
    var browse = Hub.el('a', 'btn btn--grey btn--big', 'Browse all games');
    browse.href = '/explore.html';
    all.appendChild(browse);
    main.appendChild(all);

    /* a row of the top ten, each tile carrying the place it is in */
    function chart(title, list, moreHref) {
      if (!list.length) return;
      var top = list.slice(0, 10);
      var b = Hub.box(title, { row: true, tight: true, moreHref: moreHref || null });
      b.body.appendChild(Hub.rail(top.map(function (g, i) {
        return Hub.thumb(g, members, { me: ctx.me, rank: i + 1 });
      }), chartSize(top.length)));
      main.appendChild(b.box);
    }
  }
}());
