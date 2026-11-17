/*
 * A game's page.
 *
 * The frame is never built from the query string: the id is looked up in the Hub's own
 * data and the address the server computed from owner + repo is used. Nothing loads
 * until Play is pressed, so a game with sound never starts on its own.
 */
(function () {
  'use strict';
  var head = document.getElementById('head');
  var stage = document.getElementById('stage');
  var counts = document.getElementById('counts');
  var stats = document.getElementById('stats');
  var side = document.getElementById('side');
  var lower = document.getElementById('lower');
  var lowerIn = document.getElementById('lowerIn');
  var heart = null;
  var playing = false;

  var wanted = '';
  try {
    wanted = new URLSearchParams(location.search).get('g') || '';
  } catch (e) {
    wanted = '';
  }

  Hub.bar('explore', null);
  Hub.footer();

  function nope(message) {
    document.title = 'Not here · Hub';
    Hub.clear(head);
    Hub.clear(stage);
    Hub.clear(counts);
    Hub.clear(stats);
    Hub.clear(side);
    lower.classList.add('off');
    var box = Hub.box('Not on the Hub');
    box.body.appendChild(Hub.el('p', '', message));
    var row = Hub.el('p', 'btn-row');
    var a = Hub.el('a', 'btn', 'Back to the games');
    a.href = '/explore.html';
    row.appendChild(a);
    box.body.appendChild(row);
    head.parentNode.insertBefore(box.box, head);
    stage.classList.add('off');
  }

  if (!/^[A-Za-z0-9._\/-]{1,140}$/.test(wanted)) {
    Hub.data().then(function (d) { Hub.bar('explore', d); });
    nope('That game address does not look like anything on the Hub.');
    return;
  }

  Hub.data().then(function (d) {
    Hub.bar('explore', d);
    var games = d.games || [];
    var game = null;
    for (var i = 0; i < games.length; i++) {
      if (String(games[i].id).toLowerCase() === wanted.toLowerCase()) game = games[i];
    }
    if (!game) {
      nope('That game is not on the Hub (any more). Have a look at what else is here.');
      return;
    }
    var url = Hub.playUrl(game);
    if (!url) {
      nope('That game’s address did not pass the Hub’s own check, so it was not opened.');
      return;
    }
    build(d, game, url);
  }).catch(function () {
    nope('Could not reach the Hub right now. Refresh in a minute.');
  });

  function build(d, game, url) {
    var me = d.me;
    var members = d.members || [];
    var maker = Hub.memberOf(members, game.owner);
    document.title = (game.title || 'Game') + ' · Hub';
    var beat = Hub.beat(null);

    /* ---- title row ---- */
    Hub.clear(head);
    var av = document.createElement('img');
    av.className = 'av';
    av.src = Hub.avatarUrl(maker && maker.avatar, maker && maker.id);
    av.alt = '';
    head.appendChild(av);
    var titles = Hub.el('div');
    titles.appendChild(Hub.el('h1', '', game.title || 'Untitled'));
    var by = Hub.el('div', 'by');
    by.appendChild(document.createTextNode('by '));
    var who = Hub.el('a', '', game.owner);
    who.href = '/players.html#' + encodeURIComponent(game.owner);
    by.appendChild(who);
    if (game.status === 'draft') {
      by.appendChild(document.createTextNode(' · '));
      by.appendChild(Hub.el('span', 'pill pill-draft', 'draft — only you can see this'));
    }
    titles.appendChild(by);
    head.appendChild(titles);

    var acts = Hub.el('div', 'acts');
    var full = Hub.el('button', 'btn btn--grey btn--sm');
    full.type = 'button';
    full.appendChild(Hub.icon('expand', 14));
    full.appendChild(Hub.el('span', '', 'Full screen'));
    full.addEventListener('click', goFull);
    acts.appendChild(full);
    var tab = Hub.el('a', 'btn btn--grey btn--sm', 'Open in new tab');
    tab.href = url;
    tab.target = '_blank';
    tab.rel = 'noopener noreferrer';
    acts.appendChild(tab);
    head.appendChild(acts);

    /* ---- the player, cold until Play is pressed ---- */
    Hub.clear(stage);
    var still = Hub.el('div', 'still');
    Hub.coverInto(stage, game);
    var veil = Hub.el('button', 'veil');
    veil.type = 'button';
    veil.setAttribute('aria-label', 'Play ' + (game.title || 'this game'));
    var dot = Hub.el('span', 'play-dot');
    dot.appendChild(Hub.icon('play', 34));
    veil.appendChild(dot);
    stage.appendChild(veil);

    var closeFull = Hub.el('button', 'close-full');
    closeFull.type = 'button';
    closeFull.setAttribute('aria-label', 'Leave full screen');
    closeFull.appendChild(Hub.icon('close', 20));
    closeFull.addEventListener('click', leaveFull);
    stage.appendChild(closeFull);

    veil.addEventListener('click', function () {
      if (playing) return;
      playing = true;
      var frame = document.createElement('iframe');
      frame.title = game.title || 'game';
      frame.setAttribute('sandbox',
        'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-popups');
      frame.setAttribute('allow', 'fullscreen; gamepad');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = url;
      Hub.clear(stage);
      stage.appendChild(frame);
      stage.appendChild(closeFull);
      /* say where we are first, then count the visit, then show the fresh numbers */
      beat.where(game.id)
        .then(function () { return Hub.post('/api/presence/visit', { game: game.id }); })
        .then(function () { return Hub.data(true); })
        .then(function (fresh) {
          var g2 = (fresh.games || []).find(function (x) { return x.id === game.id; });
          if (g2) {
            game.active = g2.active;
            game.visits = g2.visits;
            drawCounts(game);
          }
        })
        .catch(function () { /* the counts are not worth a fuss */ });
    });

    /* ---- active / loves / visits ---- */
    drawCounts(game);

    /* ---- the row under it ---- */
    Hub.clear(stats);
    heart = Hub.el('button', 'love-btn' + (game.lovedByMe ? ' on' : ''));
    heart.type = 'button';
    heart.appendChild(Hub.icon('heart', 18));
    heart.appendChild(Hub.el('span', 'n', String(game.loves || 0)));
    if (!me) {
      heart.disabled = true;
      heart.title = 'Sign in to love a game';
    } else if (game.status === 'draft') {
      heart.disabled = true;
      heart.title = 'Publish it first';
    } else {
      heart.addEventListener('click', function () {
        var on = !heart.classList.contains('on');
        heart.disabled = true;
        Hub.post('/api/games/love', { id: game.id, on: on }).then(function (r) {
          heart.disabled = false;
          if (!r.ok) return;
          heart.classList.toggle('on', r.lovedByMe);
          heart.querySelector('.n').textContent = String(r.loves);
          game.loves = r.loves;
          game.lovedByMe = r.lovedByMe;
          drawCounts(game);
        });
      });
    }
    stats.appendChild(heart);
    if (!me) stats.appendChild(Hub.el('span', 'small muted', 'Sign in to love this'));

    var right = Hub.el('div', 'right');
    right.appendChild(Hub.el('span', 'when', 'Updated ' + (Hub.niceDate(game.updated) || 'recently')));
    var copy = Hub.el('button', 'btn btn--grey btn--sm');
    copy.type = 'button';
    copy.appendChild(Hub.icon('link', 13));
    copy.appendChild(Hub.el('span', '', 'Copy link'));
    copy.addEventListener('click', function () {
      var link = location.origin + '/play.html?g=' + encodeURIComponent(game.id);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(function () {
          copy.querySelector('span').textContent = 'Copied';
          setTimeout(function () { copy.querySelector('span').textContent = 'Copy link'; }, 1600);
        }, function () { /* the address bar still has it */ });
      }
    });
    right.appendChild(copy);

    var report = Hub.el('button', 'btn btn--grey btn--sm');
    report.type = 'button';
    report.appendChild(Hub.icon('flag', 13));
    report.appendChild(Hub.el('span', '', 'Report'));
    report.addEventListener('click', function () {
      if (!me) {
        report.querySelector('span').textContent = 'Sign in first';
        return;
      }
      report.disabled = true;
      Hub.post('/api/games/report', { id: game.id }).then(function (r) {
        report.querySelector('span').textContent = r.ok ? 'Sent to the Hub owner' : (r.error || 'Not sent');
      });
    });
    right.appendChild(report);
    stats.appendChild(right);

    /* ---- the two boxes on the right ---- */
    Hub.clear(side);
    var howto = (game.howto || '').trim();
    var notes = (game.notes || '').trim();
    if (!howto && !notes) {
      side.appendChild(tinted('About this game', game.description || 'No notes yet.'));
    } else {
      side.appendChild(tinted('How to play', howto || 'No instructions yet.'));
      side.appendChild(tinted('Notes and credits', notes || 'Nothing here yet.'));
    }

    /* ---- the band underneath ---- */
    Hub.clear(lowerIn);
    var published = (d.games || []).filter(function (g) {
      return g.status !== 'draft' && g.id !== game.id;
    });
    var byMaker = published.filter(function (g) { return g.owner === game.owner; });
    var sameCat = published.filter(function (g) { return g.category === game.category; });
    var any = false;
    if (byMaker.length) {
      any = true;
      var b1 = Hub.box('More from ' + game.owner, {
        moreHref: '/players.html#' + encodeURIComponent(game.owner), tight: true
      });
      b1.body.appendChild(Hub.rail(byMaker.slice(0, 16).map(function (g) {
        return Hub.thumb(g, members);
      })));
      lowerIn.appendChild(b1.box);
    }
    if (sameCat.length) {
      any = true;
      var b2 = Hub.box('More ' + game.category + ' games', {
        moreHref: '/explore.html?cat=' + encodeURIComponent(game.category), tight: true
      });
      b2.body.appendChild(Hub.rail(sameCat.slice(0, 16).map(function (g) {
        return Hub.thumb(g, members);
      })));
      lowerIn.appendChild(b2.box);
    }
    lower.classList.toggle('off', !any);
  }

  function drawCounts(game) {
    Hub.clear(counts);
    [[game.active || 0, 'Playing now'], [game.loves || 0, 'Loves'], [game.visits || 0, 'Visits']]
      .forEach(function (pair) {
        var cell = Hub.el('div');
        cell.appendChild(Hub.el('div', 'n', String(pair[0])));
        cell.appendChild(Hub.el('div', 'k', pair[1]));
        counts.appendChild(cell);
      });
  }

  function tinted(title, text) {
    var box = Hub.el('div', 'tbox');
    box.appendChild(Hub.el('h2', '', title));
    var body = Hub.el('div', 'body pre', text);
    box.appendChild(body);
    return box;
  }

  /* Full screen through the browser where it is allowed, and a plain fixed layer
     where it is not. Escape or the round close button gets out either way. */
  function goFull() {
    if (stage.requestFullscreen) {
      stage.requestFullscreen().catch(function () { stage.classList.add('stage-full'); });
    } else {
      stage.classList.add('stage-full');
    }
    stage.classList.add('stage-full');
  }

  function leaveFull() {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(function () { /* class is removed below anyway */ });
    }
    stage.classList.remove('stage-full');
  }

  document.addEventListener('fullscreenchange', function () {
    if (!document.fullscreenElement) stage.classList.remove('stage-full');
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') leaveFull();
  });
}());
