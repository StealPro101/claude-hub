/* Explore: category tabs, a sort, whatever was searched for, and a grid. */
(function () {
  'use strict';
  var grid = document.getElementById('grid');
  var tabs = document.getElementById('tabs');
  var found = document.getElementById('found');
  var empty = document.getElementById('empty');
  var sort = document.getElementById('sort');
  var state = { games: [], members: [], cat: 'all', q: '', sort: 'new', ctx: null };

  try {
    var params = new URLSearchParams(location.search);
    state.q = (params.get('q') || '').trim().toLowerCase().slice(0, 60);
    state.cat = (params.get('cat') || 'all').toLowerCase().slice(0, 40);
    var s = params.get('sort');
    if (s === 'played' || s === 'az' || s === 'new') state.sort = s;
  } catch (e) { /* no query */ }
  sort.value = state.sort;

  Hub.bar('explore', null);
  Hub.footer();

  Hub.data().then(function (d) {
    Hub.bar('explore', d);
    Hub.beat(null);
    state.ctx = { me: d.me };
    state.games = (d.games || []).filter(function (g) { return g.status !== 'draft'; });
    state.members = d.members || [];
    drawTabs();
    render();
  }).catch(function () {
    Hub.fail(grid, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function cats() {
    var seen = [];
    for (var i = 0; i < state.games.length; i++) {
      var c = String(state.games[i].category || 'freestyle');
      if (seen.indexOf(c) < 0) seen.push(c);
    }
    seen.sort();
    return ['all'].concat(seen);
  }

  function drawTabs() {
    Hub.clear(tabs);
    cats().forEach(function (c) {
      var b = Hub.el('button', c === state.cat ? 'on' : '', c === 'all' ? 'All' : c);
      b.type = 'button';
      b.setAttribute('aria-pressed', c === state.cat ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.cat = c;
        drawTabs();
        render();
      });
      tabs.appendChild(b);
    });
  }

  function matches(g) {
    if (state.cat !== 'all' && String(g.category).toLowerCase() !== state.cat) return false;
    if (!state.q) return true;
    var hay = (g.title + ' ' + g.description + ' ' + g.owner + ' ' + g.category).toLowerCase();
    return hay.indexOf(state.q) >= 0;
  }

  function render() {
    var list = state.games.filter(matches);
    if (state.sort === 'played') {
      list.sort(function (a, b) { return (b.visits || 0) - (a.visits || 0); });
    } else if (state.sort === 'az') {
      list.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
    } else {
      list.sort(function (a, b) {
        return String(b.updated || '').localeCompare(String(a.updated || ''));
      });
    }
    found.textContent = (state.q ? 'Searching for “' + state.q + '” · ' : '') +
      Hub.count(list.length, 'game');
    Hub.clear(grid);
    empty.textContent = list.length ? '' : 'No games match that.';
    for (var i = 0; i < list.length; i++) {
      grid.appendChild(Hub.thumb(list[i], state.members, state.ctx));
    }
  }

  sort.addEventListener('change', function () {
    state.sort = sort.value;
    render();
  });
}());
