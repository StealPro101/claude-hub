/*
 * The play page never builds a frame address out of the query string. It looks the id
 * up in the Hub's own data and uses the address the server computed from owner + repo.
 *
 * A member's game lives on <login>.github.io, a different origin, so it goes in a
 * sandboxed iframe. A house game in /games/ is same origin with the Hub, so it is
 * never framed with scripts - the page links straight to it instead.
 */
(function () {
  'use strict';
  var holder = document.getElementById('holder');
  var title = document.getElementById('pTitle');
  var by = document.getElementById('pBy');
  var acts = document.getElementById('acts');
  var note = document.getElementById('note');

  var wanted = '';
  try {
    wanted = new URLSearchParams(location.search).get('g') || '';
  } catch (e) {
    wanted = '';
  }

  function nope(message) {
    title.textContent = 'Not on the Hub';
    by.textContent = '';
    Hub.clear(holder);
    var box = Hub.el('div', 'panel');
    box.appendChild(Hub.el('p', 'mini', message));
    var a = Hub.el('a', 'btn alt sm', 'back to the arcade');
    a.href = '/';
    a.classList.add('mt-m');
    box.appendChild(a);
    holder.appendChild(box);
  }

  if (!/^[A-Za-z0-9._\/-]{1,140}$/.test(wanted)) {
    nope('That game address does not look like anything on the Hub.');
    return;
  }

  Hub.data().then(function (d) {
    Hub.nav('arcade', d.me);
    var game = null;
    var games = Array.isArray(d.games) ? d.games : [];
    for (var i = 0; i < games.length; i++) {
      if (String(games[i].id).toLowerCase() === wanted.toLowerCase()) game = games[i];
    }
    if (!game) {
      nope('That game is not on the Hub (any more). Have a look at the arcade.');
      return;
    }
    var url = Hub.playUrl(game);
    if (!url) {
      nope('That game’s address did not pass the Hub’s own check, so it was not opened.');
      return;
    }

    title.textContent = game.title || 'Untitled';
    by.textContent = 'by @' + game.owner + (game.category ? ' · ' + game.category : '');

    var open = Hub.el('a', 'btn alt sm', 'open in new tab');
    open.href = url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    acts.appendChild(open);

    if (game.repoUrl && String(game.repoUrl).indexOf('https://github.com/') === 0) {
      var code = Hub.el('a', 'btn alt sm', 'code');
      code.href = game.repoUrl;
      code.target = '_blank';
      code.rel = 'noopener noreferrer';
      acts.appendChild(code);
    }

    var report = Hub.el('a', 'btn alt sm', 'report');
    report.href = '/rules.html#report';
    acts.appendChild(report);

    Hub.clear(holder);
    if (game.legacy) {
      var panel = Hub.el('div', 'panel');
      panel.appendChild(Hub.el('h2', '', game.title || 'Untitled'));
      panel.appendChild(Hub.el('p', 'desc', game.description || ''));
      var go = Hub.el('a', 'btn', '▶ OPEN THE GAME');
      go.href = url;
      go.classList.add('mt-m');
      panel.appendChild(go);
      panel.appendChild(Hub.el('p', 'mini', 'House games open on their own page.'));
      holder.appendChild(panel);
      note.textContent = '';
      return;
    }

    var frame = document.createElement('iframe');
    frame.className = 'frame';
    frame.title = game.title || 'game';
    frame.setAttribute('sandbox',
      'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-popups');
    frame.setAttribute('allow', 'fullscreen; gamepad');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.src = url;
    holder.appendChild(frame);
    note.textContent = 'This game runs on ' + game.owner +
      '.github.io. The Hub does not check anyone’s code - play at your own risk.';
  }).catch(function () {
    nope('Could not reach the Hub right now. Refresh in a minute.');
  });
}());
