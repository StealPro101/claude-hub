/*
 * A game's page, in two states.
 *
 * 1. The details: picture, name, maker, one big Play button, the numbers, how to play.
 * 2. In the game: Play takes over the whole window. Nothing of the site is left except
 *    one big round Leave button in the corner, over the game. Pressing it (or Escape)
 *    asks once - Leave or Keep playing - and the browser's Back button leaves too.
 *
 * The frame is never built from the query string: the id is looked up in the Hub's own
 * data and the address the server computed from owner + repo is used. Nothing loads
 * until Play is pressed, so a game with sound never starts on its own.
 */
(function () {
  'use strict';
  var media = document.getElementById('media');
  var info = document.getElementById('info');
  var counts = document.getElementById('counts');
  var about = document.getElementById('about');
  var lower = document.getElementById('lower');
  var lowerIn = document.getElementById('lowerIn');
  var layer = document.getElementById('ingame');
  var inGame = false;
  var leaveNow = null;

  var wanted = '';
  try {
    wanted = new URLSearchParams(location.search).get('g') || '';
  } catch (e) {
    wanted = '';
  }

  /* a reload or a shared link never drops anyone straight into a game */
  if (location.hash === '#play') {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* the hash is harmless */ }
  }

  Hub.bar('explore', null);

  function nope(message) {
    document.title = 'Not here · Hub';
    [media, info, counts, about].forEach(function (n) { Hub.clear(n); });
    document.getElementById('gp').classList.add('off');
    counts.classList.add('off');
    lower.classList.add('off');
    about.classList.add('gp-about--one');
    var box = Hub.box('Not on the Hub');
    box.body.appendChild(Hub.el('p', '', message));
    var row = Hub.el('p', 'btn-row');
    var a = Hub.el('a', 'btn', 'Back to the games');
    a.href = '/explore.html';
    row.appendChild(a);
    box.body.appendChild(row);
    about.appendChild(box.box);
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
    var title = game.title || 'Untitled';
    document.title = title + ' · Hub';
    var beat = Hub.beat(null);

    /* ---- the picture ---- */
    Hub.clear(media);
    Hub.coverInto(media, game);

    /* ---- name, maker, Play ---- */
    Hub.clear(info);
    info.appendChild(Hub.el('h1', '', title));

    var by = Hub.el('div', 'gp-by');
    var av = document.createElement('img');
    av.src = Hub.avatarUrl(maker && maker.avatar, maker && maker.id);
    av.alt = '';
    by.appendChild(av);
    by.appendChild(document.createTextNode('By '));
    var who = Hub.el('a', '', game.owner);
    who.href = '/players.html#' + encodeURIComponent(game.owner);
    by.appendChild(who);
    info.appendChild(by);
    if (game.status === 'draft') {
      var note = Hub.el('div', 'gp-draft');
      note.appendChild(Hub.el('span', 'pill pill-draft', 'Draft — only you can see this'));
      /* straight to the editor for this one, not to a page of boxes */
      if (me && me.login === game.owner) {
        var fix = Hub.el('a', 'small', 'Set it up');
        fix.href = '/mygames.html#edit=' + encodeURIComponent(
          game.repo || game.id.slice(game.id.indexOf('/') + 1));
        note.appendChild(fix);
      }
      info.appendChild(note);
    }

    /* the one-line pitch sits here only when the boxes below hold something else */
    var pitch = (game.description || '').trim();
    if (pitch && ((game.howto || '').trim() || (game.notes || '').trim())) {
      info.appendChild(Hub.el('p', 'gp-desc', pitch));
    }

    var play = Hub.el('button', 'gp-play');
    play.type = 'button';
    play.setAttribute('aria-label', 'Play ' + title);
    play.appendChild(Hub.icon('play', 30));
    play.appendChild(Hub.el('span', '', 'Play'));
    info.appendChild(play);

    var nowLine = Hub.el('div', 'gp-now');
    info.appendChild(nowLine);

    /*
     * The star. A favourite is private and uncounted - the button says whether this
     * game is on YOUR list and nothing more.
     */
    var acts = Hub.el('div', 'gp-acts');
    var star = Hub.el('button', 'fav-btn' + (game.favorite ? ' on' : ''));
    star.type = 'button';
    var starWord = Hub.el('span', 'w', game.favorite ? 'Favorited' : 'Favorite');
    function paintStar() {
      Hub.clear(star);
      star.appendChild(Hub.starIcon(game.favorite, 18));
      starWord.textContent = game.favorite ? 'Favorited' : 'Favorite';
      star.appendChild(starWord);
      star.classList.toggle('on', Boolean(game.favorite));
      star.setAttribute('aria-pressed', game.favorite ? 'true' : 'false');
    }
    paintStar();
    if (!me) {
      star.disabled = true;
      starWord.textContent = 'Favorite';
      star.title = 'Sign in to favorite a game';
      star.setAttribute('aria-label', 'Favorite (sign in first)');
    } else if (game.status === 'draft') {
      star.disabled = true;
      star.title = 'Publish it first';
    } else {
      star.addEventListener('click', function () {
        var want = !game.favorite;
        star.disabled = true;
        Hub.post('/api/games/favorite', { id: game.id, on: want }).then(function (r) {
          star.disabled = false;
          if (!r.ok) return;
          game.favorite = Boolean(r.favorite);
          paintStar();
        });
      });
    }
    acts.appendChild(star);

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
    acts.appendChild(copy);

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
        report.querySelector('span').textContent = r.ok ? 'Sent to the owner' : (r.error || 'Not sent');
      });
    });
    acts.appendChild(report);
    info.appendChild(acts);

    /* ---- the numbers ---- */
    function drawCounts(g) {
      Hub.clear(counts);
      [
        ['Playing now', Hub.compact(g.active || 0)],
        ['Visits', Hub.compact(g.visits || 0)],
        ['Updated', Hub.niceDate(g.updated) || 'recently'],
        ['Category', g.category || 'freestyle']
      ].forEach(function (pair) {
        var cell = Hub.el('div');
        cell.appendChild(Hub.el('div', 'k', pair[0]));
        cell.appendChild(Hub.el('div', 'n', pair[1]));
        counts.appendChild(cell);
      });
      Hub.clear(nowLine);
      if (g.active > 0) {
        nowLine.appendChild(Hub.el('span', 'dot-live'));
        nowLine.appendChild(document.createTextNode(
          g.active + (g.active === 1 ? ' person is' : ' people are') + ' playing right now'));
      }
    }
    drawCounts(game);

    /* ---- how to play / notes ---- */
    Hub.clear(about);
    var howto = (game.howto || '').trim();
    var notes = (game.notes || '').trim();
    if (!howto && !notes) {
      about.classList.add('gp-about--one');
      about.appendChild(tinted('About this game', game.description || 'No notes yet.'));
    } else {
      about.appendChild(tinted('How to play', howto || 'No instructions yet.'));
      about.appendChild(tinted('Notes and credits', notes || 'Nothing here yet.'));
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
        moreHref: '/players.html#' + encodeURIComponent(game.owner), tight: true, row: true
      });
      b1.body.appendChild(Hub.rail(byMaker.slice(0, 16).map(function (g) {
        return Hub.thumb(g, members, { me: me });
      })));
      lowerIn.appendChild(b1.box);
    }
    if (sameCat.length) {
      any = true;
      var b2 = Hub.box('More ' + game.category + ' games', {
        moreHref: '/explore.html?cat=' + encodeURIComponent(game.category), tight: true, row: true
      });
      b2.body.appendChild(Hub.rail(sameCat.slice(0, 16).map(function (g) {
        return Hub.thumb(g, members, { me: me });
      })));
      lowerIn.appendChild(b2.box);
    }
    lower.classList.toggle('off', !any);

    /* ---- in the game: the whole window, one round way out ---- */
    Hub.clear(layer);
    var host = Hub.el('div', 'ig-frame');
    layer.appendChild(host);

    var leave = Hub.el('button', 'ig-leave');
    leave.type = 'button';
    leave.setAttribute('aria-label', 'Leave game');
    leave.title = 'Leave';
    leave.appendChild(Hub.icon('exit', 26));
    leave.appendChild(Hub.el('span', 'w', 'Leave'));
    layer.appendChild(leave);

    /* the one question this layer ever asks, over the game it covers */
    var ask = Hub.el('div', 'ig-ask off');
    ask.setAttribute('role', 'dialog');
    ask.setAttribute('aria-modal', 'true');
    ask.setAttribute('aria-labelledby', 'igAskHead');
    var card = Hub.el('div', 'ig-card');
    var head = Hub.el('h2', 'ig-head', 'Leave this game?');
    head.id = 'igAskHead';
    card.appendChild(head);
    var pair = Hub.el('div', 'ig-pair');
    var yes = Hub.el('button', 'ig-big ig-yes', 'Leave');
    yes.type = 'button';
    var no = Hub.el('button', 'ig-big ig-no', 'Keep playing');
    no.type = 'button';
    pair.appendChild(yes);
    pair.appendChild(no);
    card.appendChild(pair);
    ask.appendChild(card);
    layer.appendChild(ask);

    function askLeave(on) {
      ask.classList.toggle('off', !on);
      if (on) {
        no.focus();
      } else if (inGame) {
        var frame = host.firstChild;
        if (frame && frame.focus) {
          try { frame.focus(); } catch (e) { /* the next click focuses it */ }
        }
      }
    }

    function enter() {
      if (inGame) return;
      inGame = true;
      askLeave(false);
      var frame = document.createElement('iframe');
      frame.title = title;
      frame.setAttribute('sandbox',
        'allow-scripts allow-same-origin allow-pointer-lock allow-forms allow-modals allow-popups');
      frame.setAttribute('allow', 'fullscreen; gamepad');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.src = url;
      Hub.clear(host);
      host.appendChild(frame);
      layer.classList.remove('off');
      document.documentElement.classList.add('in-game');
      try {
        history.pushState({ hubPlay: true }, '', location.pathname + location.search + '#play');
      } catch (e) { /* Leave still works without the history entry */ }
      try {
        frame.focus();
      } catch (e) { /* the first click in the game focuses it */ }
      /* say where we are first, then count the visit */
      beat.where(game.id)
        .then(function () { return Hub.post('/api/presence/visit', { game: game.id }); })
        .catch(function () { /* the counts are not worth a fuss */ });
    }

    function out() {
      if (!inGame) return;
      inGame = false;
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(function () { /* already out */ });
      }
      Hub.clear(host);
      layer.classList.add('off');
      document.documentElement.classList.remove('in-game');
      askLeave(false);
      play.focus();
      beat.where(null)
        .then(function () { return Hub.data(true); })
        .then(function (fresh) {
          var g2 = (fresh.games || []).find(function (x) { return x.id === game.id; });
          if (g2) {
            game.active = g2.active;
            game.visits = g2.visits;
            drawCounts(game);
          }
        })
        .catch(function () { /* old numbers are fine */ });
    }

    /* Leave goes through the history entry Play made, so Back and Leave are one path */
    leaveNow = function () {
      if (history.state && history.state.hubPlay) history.back();
      else out();
    };

    play.addEventListener('click', enter);
    /* the round button opens the question, and closes it again if it is already open */
    leave.addEventListener('click', function () {
      askLeave(ask.classList.contains('off'));
    });
    no.addEventListener('click', function () { askLeave(false); });
    yes.addEventListener('click', function () { leaveNow(); });
    /* a press on the dim part, beside the card, is "keep playing" */
    ask.addEventListener('click', function (ev) {
      if (ev.target === ask) askLeave(false);
    });
    window.addEventListener('popstate', function () {
      if (inGame && !(history.state && history.state.hubPlay)) out();
    });

    document.addEventListener('keydown', function (ev) {
      if (!inGame || ev.key !== 'Escape') return;
      askLeave(ask.classList.contains('off'));
    });
  }

  function tinted(title, text) {
    var box = Hub.el('div', 'tbox');
    box.appendChild(Hub.el('h2', '', title));
    var body = Hub.el('div', 'body pre', text);
    box.appendChild(body);
    return box;
  }
}());
