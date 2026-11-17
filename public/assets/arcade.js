/* The arcade: round banner, category chips, search, game cards. */
(function () {
  'use strict';
  var grid = document.getElementById('grid');
  var chipsEl = document.getElementById('chips');
  var countEl = document.getElementById('count');
  var q = document.getElementById('q');
  var state = { games: [], members: [], cat: 'ALL', text: '' };

  Hub.nav('arcade', null);

  Hub.data().then(function (d) {
    state.games = Array.isArray(d.games) ? d.games : [];
    state.members = Array.isArray(d.members) ? d.members : [];
    Hub.nav('arcade', d.me);
    Hub.roundBanner(d.round);
    chips();
    render();
  }).catch(function () {
    Hub.fail(grid, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function chips() {
    var seen = ['ALL'];
    for (var i = 0; i < state.games.length; i++) {
      var c = String(state.games[i].category || 'freestyle');
      if (seen.indexOf(c) < 0) seen.push(c);
    }
    Hub.clear(chipsEl);
    for (var j = 0; j < seen.length; j++) {
      (function (c) {
        var b = Hub.el('button', 'chip' + (c === state.cat ? ' on' : ''), c.toUpperCase());
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
    if (state.cat !== 'ALL' && String(g.category) !== state.cat) return false;
    if (!state.text) return true;
    var hay = (g.title + ' ' + g.description + ' ' + g.owner + ' ' + g.category).toLowerCase();
    return hay.indexOf(state.text) >= 0;
  }

  function render() {
    var list = state.games.filter(matches);
    countEl.textContent = list.length
      ? list.length + (list.length === 1 ? ' GAME' : ' GAMES') + ' IN THE ARCADE'
      : '';
    Hub.clear(grid);
    if (!list.length) {
      var empty = Hub.el('div', 'empty', state.text || state.cat !== 'ALL'
        ? 'Nothing matches that.'
        : 'No games yet. Be the first!');
      grid.appendChild(empty);
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
