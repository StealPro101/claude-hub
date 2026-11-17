/* The arcade: the shelf up top, the round strip, then every game in a calm grid. */
(function () {
  'use strict';
  var grid = document.getElementById('grid');
  var chipsEl = document.getElementById('chips');
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('empty');
  var q = document.getElementById('q');
  var state = { games: [], members: [], cat: 'all', text: '' };

  Hub.nav('arcade', null);

  Hub.data().then(function (d) {
    state.games = Array.isArray(d.games) ? d.games : [];
    state.members = Array.isArray(d.members) ? d.members : [];
    Hub.nav('arcade', d.me);
    Hub.strip(d.round);
    shelf();
    chips();
    render();
  }).catch(function () {
    Hub.fail(grid, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  /* The shelf is the shop window: published games only, newest first, up to forty. */
  function shelf() {
    var on = state.games.filter(function (g) { return g.status !== 'draft'; }).slice(0, 40);
    Shelf.build(document.getElementById('shelf'), on, state.members, function (host) {
      var box = Hub.el('div', 'shelf-empty');
      box.appendChild(Hub.el('p', 'big', 'The shelf is empty. Somebody has to go first.'));
      box.appendChild(Hub.el('p', '',
        'Make a little game, put it in a public repo on your own GitHub, and it lands here.'));
      var a = Hub.el('a', 'btn btn--go', 'How to join');
      a.href = '/join.html';
      box.appendChild(a);
      host.appendChild(box);
    });
    if (on.length && on.length <= 40) {
      var touch = window.matchMedia('(hover: none)').matches;
      var hint = Hub.el('p', 'shelf-hint',
        on.length <= 3 ? 'Pick one' : touch ? 'Swipe the shelf' : 'Move along the shelf');
      document.getElementById('shelfOuter').appendChild(hint);
    }
  }

  function chips() {
    var seen = ['all'];
    for (var i = 0; i < state.games.length; i++) {
      var c = String(state.games[i].category || 'freestyle');
      if (seen.indexOf(c) < 0) seen.push(c);
    }
    Hub.clear(chipsEl);
    for (var j = 0; j < seen.length; j++) {
      (function (c) {
        var b = Hub.el('button', 'chip' + (c === state.cat ? ' on' : ''), c);
        b.type = 'button';
        b.setAttribute('aria-pressed', c === state.cat ? 'true' : 'false');
        b.addEventListener('click', function () {
          state.cat = c;
          chips();
          render();
        });
        chipsEl.appendChild(b);
      }(seen[j]));
    }
  }

  function matches(g) {
    if (state.cat !== 'all' && String(g.category) !== state.cat) return false;
    if (!state.text) return true;
    var hay = (g.title + ' ' + g.description + ' ' + g.owner + ' ' + g.category).toLowerCase();
    return hay.indexOf(state.text) >= 0;
  }

  function render() {
    var list = state.games.filter(matches);
    countEl.textContent = list.length ? list.length + (list.length === 1 ? ' game' : ' games') : '';
    Hub.clear(grid);
    emptyEl.textContent = '';
    if (!list.length) {
      emptyEl.textContent = state.text || state.cat !== 'all'
        ? 'Nothing matches that.'
        : 'No games yet.';
      return;
    }
    for (var i = 0; i < list.length; i++) grid.appendChild(Hub.gameCard(list[i], state.members));
  }

  if (q) {
    q.addEventListener('input', function () {
      state.text = q.value.trim().toLowerCase();
      render();
    });
  }
}());
