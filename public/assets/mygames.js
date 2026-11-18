/*
 * My games, built around the thing you came to do.
 *
 * Three views, one at a time, never a form hidden at the top of a long page:
 *   the list     everything you have, with the one primary button at the top right
 *   add          the projects on your account that could be games - Add goes straight
 *                into the editor for that game
 *   the editor   one game, every field, and a sticky row saying what will happen
 *
 * mygames.html#edit=<repo> opens the editor directly, which is where the draft notice
 * on a game page and the drafts badge in the bar both point.
 *
 * The server re-checks that every repo is really theirs, every time.
 */
(function () {
  'use strict';
  var me = null;
  var hub = null;
  var editing = null;
  var cropper = null;
  var filter = 'all';
  var view = 'list';

  var listView = document.getElementById('listView');
  var addView = document.getElementById('addView');
  var editView = document.getElementById('editView');

  function say(id, text, bad) {
    var n = document.getElementById(id);
    if (!n) return;
    n.textContent = text || '';
    n.className = 'msg ' + (bad ? 'bad' : 'ok');
  }

  Hub.bar('mygames', null);

  Hub.data().then(start).catch(function () { Hub.show('signedOut', true); });

  function start(d) {
    hub = d;
    me = d.me;
    Hub.bar('mygames', d);
    if (!me) {
      Hub.show('signedOut', true);
      return;
    }
    Hub.beat(null);
    Hub.show('signedIn', true);
    var member = Hub.memberOf(d.members, me.login);
    document.getElementById('showMe').checked = !(member && member.hidePresence);
    HubPrompt.mount('prompt', 'copy', 'copyMsg');
    fillCategories(d);
    cropper = Cover.make({
      box: document.getElementById('crop'),
      canvas: document.getElementById('cropCanvas'),
      empty: document.getElementById('cropEmpty'),
      onChange: function (ev) {
        if (ev && ev.error) say('fMsg', ev.error, true);
        else say('fMsg', 'Drag the picture to choose what shows.');
      }
    });
    drawList();
    route();
  }

  function fillCategories(d) {
    var sel = document.getElementById('fCat');
    Hub.clear(sel);
    var list = Array.isArray(d.categories) && d.categories.length ? d.categories : ['freestyle'];
    for (var i = 0; i < list.length; i++) {
      var o = document.createElement('option');
      o.value = list[i];
      o.textContent = list[i];
      sel.appendChild(o);
    }
  }

  function mineOnly() {
    var low = String(me.login).toLowerCase();
    return (hub.games || []).filter(function (g) {
      return !g.house && String(g.owner).toLowerCase() === low;
    }).sort(function (a, b) {
      return String(b.updated || '').localeCompare(String(a.updated || ''));
    });
  }

  function repoOf(game) {
    return game.repo || game.id.slice(game.id.indexOf('/') + 1);
  }

  function isDraft(game) { return game.status === 'draft'; }

  /* ---------- which view is on ---------- */

  function show(which) {
    view = which;
    Hub.show(listView, which === 'list');
    Hub.show(addView, which === 'add');
    Hub.show(editView, which === 'edit');
    window.scrollTo(0, 0);
  }

  function route() {
    var h = '';
    try { h = decodeURIComponent(location.hash.replace(/^#/, '')); } catch (e) { h = ''; }
    if (h.indexOf('edit=') === 0) {
      var repo = h.slice(5);
      var game = mineOnly().filter(function (g) {
        return repoOf(g).toLowerCase() === repo.toLowerCase();
      })[0];
      if (game) {
        openEditor(game);
        return;
      }
      say('msg', 'That game is not on your list any more.', true);
    }
    if (h === 'add') {
      openAdd();
      return;
    }
    if (h === 'drafts' || h === 'shared' || h === 'all') {
      filter = h;
      drawList();
    }
    show('list');
  }

  window.addEventListener('hashchange', route);

  function backToList(message) {
    if (location.hash) {
      try {
        history.replaceState(null, '', location.pathname);
      } catch (e) { location.hash = ''; }
    }
    editing = null;
    show('list');
    if (message) say('msg', message);
  }

  /* ---------- the list ---------- */

  function counts() {
    var all = mineOnly();
    return {
      all: all.length,
      drafts: all.filter(isDraft).length,
      shared: all.filter(function (g) { return !isDraft(g); }).length
    };
  }

  function drawFilters() {
    var host = document.getElementById('filters');
    var n = counts();
    Hub.clear(host);
    [['all', 'All', n.all], ['drafts', 'Drafts', n.drafts], ['shared', 'Shared', n.shared]]
      .forEach(function (row) {
        var b = Hub.el('button', 'mg-tab' + (filter === row[0] ? ' on' : ''));
        b.type = 'button';
        b.setAttribute('aria-pressed', filter === row[0] ? 'true' : 'false');
        b.appendChild(Hub.el('span', 'w', row[1]));
        b.appendChild(Hub.el('span', 'n', String(row[2])));
        b.addEventListener('click', function () {
          filter = row[0];
          drawList();
        });
        host.appendChild(b);
      });
  }

  function row(game) {
    var r = Hub.el('div', 'mg-row');
    var shot = Hub.el('a', 'mg-shot');
    shot.href = '/play.html?g=' + encodeURIComponent(game.id);
    Hub.coverInto(shot, game);
    r.appendChild(shot);

    var mid = Hub.el('div', 'mg-mid');
    var name = Hub.el('a', 'mg-name', game.title || 'Untitled');
    name.href = '/play.html?g=' + encodeURIComponent(game.id);
    mid.appendChild(name);
    mid.appendChild(Hub.el('div', 'mg-state' + (isDraft(game) ? ' draft' : ''),
      isDraft(game)
        ? 'Draft — only you can see this'
        : 'Shared · ' + Hub.compact(game.visits || 0) +
          ((game.visits || 0) === 1 ? ' visit' : ' visits')));
    mid.appendChild(Hub.el('div', 'mg-when',
      'changed ' + (Hub.niceDate(game.updated) || 'recently')));
    r.appendChild(mid);

    var acts = Hub.el('div', 'mg-acts');
    var repo = repoOf(game);

    var edit = Hub.el('button', 'btn btn--sm' + (isDraft(game) ? '' : ' btn--ghost'),
      isDraft(game) ? 'Set up & publish' : 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', function () { openEditor(game); });
    acts.appendChild(edit);

    var quiet = Hub.el('div', 'mg-quiet');
    var play = Hub.el('a', 'linkbtn', isDraft(game) ? 'Test' : 'Open');
    play.href = '/play.html?g=' + encodeURIComponent(game.id);
    quiet.appendChild(play);

    if (!isDraft(game)) {
      var un = Hub.el('button', 'linkbtn', 'Unpublish');
      un.type = 'button';
      un.addEventListener('click', function () {
        un.disabled = true;
        Hub.post('/api/games/unpublish', { repo: repo }).then(function (res) {
          if (res.ok) reload('“' + (game.title || repo) + '” is a draft again. Only you can see it.');
          else {
            say('msg', res.error, true);
            un.disabled = false;
          }
        });
      });
      quiet.appendChild(un);
    }

    /* removing asks once, right here - never a browser box */
    var rm = Hub.el('button', 'linkbtn danger', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', function () {
      Hub.clear(quiet);
      var ask = Hub.el('span', 'mg-ask', 'Take it off the Hub?');
      var yes = Hub.el('button', 'linkbtn danger', 'Remove');
      yes.type = 'button';
      yes.addEventListener('click', function () {
        yes.disabled = true;
        Hub.post('/api/games/remove', { repo: repo }).then(function (res) {
          if (res.ok) reload('Removed “' + (game.title || repo) + '”. Your project on GitHub is untouched.');
          else {
            say('msg', res.error, true);
            drawList();
          }
        });
      });
      var no = Hub.el('button', 'linkbtn', 'Keep it');
      no.type = 'button';
      no.addEventListener('click', drawList);
      quiet.appendChild(ask);
      quiet.appendChild(yes);
      quiet.appendChild(no);
      yes.focus();
    });
    quiet.appendChild(rm);
    acts.appendChild(quiet);
    r.appendChild(acts);
    return r;
  }

  function emptyNote() {
    var box = Hub.el('div', 'mg-empty');
    if (filter === 'drafts') {
      box.appendChild(Hub.el('p', '', 'No drafts waiting.'));
      box.appendChild(Hub.el('p', 'muted',
        'A draft is a game only you can see, until you set it up and publish it.'));
    } else if (filter === 'shared') {
      box.appendChild(Hub.el('p', '', 'You have not shared a game yet.'));
      box.appendChild(Hub.el('p', 'muted',
        'Open a draft, give it a name and a picture, and press Publish.'));
    } else {
      box.appendChild(Hub.el('p', '', 'Nothing here yet.'));
      box.appendChild(Hub.el('p', 'muted',
        'Press “Add a game” and pick one of your GitHub projects. It arrives as a draft.'));
    }
    var p = Hub.el('p', 'btn-row mt');
    var a = Hub.el('button', 'btn', 'Add a game');
    a.type = 'button';
    a.addEventListener('click', openAdd);
    p.appendChild(a);
    box.appendChild(p);
    return box;
  }

  function drawList() {
    drawFilters();
    var all = mineOnly();
    var list = all.filter(function (g) {
      if (filter === 'drafts') return isDraft(g);
      if (filter === 'shared') return !isDraft(g);
      return true;
    });
    var host = document.getElementById('rows');
    Hub.clear(host);
    if (!list.length) {
      host.appendChild(emptyNote());
      return;
    }
    list.forEach(function (g) { host.appendChild(row(g)); });
  }

  function reload(message) {
    return Hub.data(true).then(function (d) {
      hub = d;
      Hub.bar('mygames', d);
      drawList();
      if (message) say('msg', message);
      return d;
    });
  }

  /* ---------- adding ---------- */

  function openAdd() {
    say('addMsg', '');
    show('add');
    loadRepos();
    document.getElementById('addBack').focus();
  }

  document.getElementById('addBtn').addEventListener('click', function () { openAdd(); });
  document.getElementById('addBack').addEventListener('click', function (ev) {
    ev.preventDefault();
    backToList('');
  });

  function loadRepos() {
    var box = document.getElementById('repos');
    Hub.clear(box);
    box.appendChild(Hub.el('p', 'muted', 'Looking at your GitHub projects…'));
    fetch('/api/my/repos', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        Hub.clear(box);
        if (!j.ok) {
          box.appendChild(Hub.el('p', 'muted', j.error || 'GitHub did not answer.'));
          return;
        }
        if (!j.repos.length) {
          box.appendChild(Hub.el('p', 'muted',
            'No projects are ready yet. Make a public repo with your game in index.html and switch GitHub Pages on.'));
          return;
        }
        j.repos.forEach(function (r) { box.appendChild(repoRow(r)); });
      })
      .catch(function () {
        Hub.clear(box);
        box.appendChild(Hub.el('p', 'muted', 'Could not ask GitHub right now.'));
      });
  }

  function repoRow(r) {
    var item = Hub.el('div', 'mg-row mg-row--repo');
    var mid = Hub.el('div', 'mg-mid');
    mid.appendChild(Hub.el('div', 'mg-name', r.repo));
    var bits = [];
    if (r.description) bits.push(r.description);
    if (r.updated) bits.push('changed ' + Hub.ago(r.updated));
    mid.appendChild(Hub.el('div', 'mg-when', bits.join(' · ') || 'ready'));
    item.appendChild(mid);

    var acts = Hub.el('div', 'mg-acts');
    if (r.onHub) {
      acts.appendChild(Hub.el('span', 'pill pill-live', 'already added'));
    } else {
      var add = Hub.el('button', 'btn btn--sm', 'Add');
      add.type = 'button';
      add.addEventListener('click', function () {
        add.disabled = true;
        say('addMsg', 'adding…');
        Hub.post('/api/games/add', { repo: r.repo }).then(function (res) {
          if (!res.ok) {
            say('addMsg', res.error, true);
            add.disabled = false;
            return;
          }
          /* straight into the editor for it - that is what you came to do */
          reload('').then(function () {
            var game = mineOnly().filter(function (g) {
              return repoOf(g).toLowerCase() === r.repo.toLowerCase();
            })[0];
            say('addMsg', '');
            if (game) openEditor(game, 'Added as a draft. Give it a name and a picture.');
            else backToList('Added ' + r.repo + ' as a draft.');
          });
        });
      });
      acts.appendChild(add);
    }
    item.appendChild(acts);
    return item;
  }

  /* ---------- the editor ---------- */

  function openEditor(game, note) {
    editing = game;
    var draft = isDraft(game);
    document.getElementById('editTitle').textContent = game.title || repoOf(game);
    document.getElementById('editFor').textContent =
      (draft ? 'Draft · ' : 'Shared · ') + game.id;
    document.getElementById('fName').value = game.title || '';
    document.getElementById('fDesc').value = game.description || '';
    document.getElementById('fHow').value = game.howto || '';
    document.getElementById('fNotes').value = game.notes || '';
    var sel = document.getElementById('fCat');
    sel.value = game.category || 'freestyle';
    if (!sel.value && sel.options.length) sel.value = sel.options[0].value;
    document.getElementById('fPublish').textContent = draft ? 'Publish' : 'Save changes';
    document.getElementById('fSave').textContent = 'Save as draft';
    /* nothing to remove when there is no picture yet */
    Hub.show('coverOffRow', Boolean(game.cover));
    cropper.reset();
    say('fMsg', note || (draft
      ? 'Nobody sees this until you press Publish.'
      : 'This one is in the arcade. Changes show up as soon as you save.'));
    show('edit');
    try {
      history.replaceState(null, '', location.pathname + '#edit=' + encodeURIComponent(repoOf(game)));
    } catch (e) { /* the editor is open either way */ }
    document.getElementById('fName').focus();
  }

  document.getElementById('editBack').addEventListener('click', function (ev) {
    ev.preventDefault();
    backToList('');
  });

  function saveMeta() {
    return Hub.post('/api/games/meta', {
      repo: repoOf(editing),
      title: document.getElementById('fName').value,
      description: document.getElementById('fDesc').value,
      category: document.getElementById('fCat').value,
      howto: document.getElementById('fHow').value,
      notes: document.getElementById('fNotes').value
    });
  }

  async function saveCover() {
    if (!cropper.has() || !cropper.changed()) return { ok: true };
    var out = await cropper.exportBlob();
    if (!out) return { ok: false, error: 'the picture could not be prepared' };
    var r = await fetch('/api/games/cover?repo=' + encodeURIComponent(repoOf(editing)), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': out.type },
      body: out.blob
    });
    var j = await r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
    if (j.ok) cropper.clean();
    return j;
  }

  /* what: 'publish' | 'draft' | 'save' */
  async function finish(what) {
    var btn = document.getElementById(what === 'publish' ? 'fPublish' : 'fSave');
    var was = editing;
    btn.disabled = true;
    say('fMsg', 'saving…');
    try {
      var meta = await saveMeta();
      if (!meta.ok) {
        say('fMsg', meta.error, true);
        return;
      }
      var cover = await saveCover();
      if (!cover.ok) {
        say('fMsg', cover.error, true);
        return;
      }
      if (what === 'publish') {
        var pub = await Hub.post('/api/games/publish', { repo: repoOf(was) });
        if (!pub.ok) {
          say('fMsg', pub.error, true);
          return;
        }
      }
      if (what === 'draft' && !isDraft(was)) {
        var un = await Hub.post('/api/games/unpublish', { repo: repoOf(was) });
        if (!un.ok) {
          say('fMsg', un.error, true);
          return;
        }
      }
      await reload('');
      backToList('');
      done(what, was);
    } finally {
      btn.disabled = false;
    }
  }

  /* say plainly what happened, with a way to go and look */
  function done(what, game) {
    var host = document.getElementById('msg');
    Hub.clear(host);
    host.className = 'msg ok';
    var said = what === 'publish'
      ? 'Published — it is in the arcade now.'
      : (what === 'draft'
        ? 'Saved as a draft — only you can see it now.'
        : 'Saved. The changes are live.');
    host.appendChild(document.createTextNode(said + ' '));
    var a = Hub.el('a', '', 'See its page');
    a.href = '/play.html?g=' + encodeURIComponent(game.id);
    host.appendChild(a);
  }

  document.getElementById('fPublish').addEventListener('click', function () {
    finish(editing && isDraft(editing) ? 'publish' : 'save');
  });
  document.getElementById('fSave').addEventListener('click', function () { finish('draft'); });
  document.getElementById('fClose').addEventListener('click', function () { backToList(''); });
  document.getElementById('file').addEventListener('change', function (ev) {
    if (ev.target.files && ev.target.files[0]) cropper.load(ev.target.files[0]);
  });
  document.getElementById('fCoverOff').addEventListener('click', function () {
    if (!editing) return;
    cropper.reset();
    Hub.post('/api/games/cover-remove', { repo: repoOf(editing) }).then(function (res) {
      if (res.ok) {
        say('fMsg', 'Picture removed.');
        Hub.show('coverOffRow', false);
        Hub.data(true).then(function (d) {
          hub = d;
          drawList();
        });
      } else {
        say('fMsg', res.error, true);
      }
    });
  });

  document.getElementById('showMe').addEventListener('change', function (ev) {
    Hub.post('/api/me/presence', { show: ev.target.checked }).then(function (r) {
      say('setMsg', r.ok
        ? (r.show ? 'Others can see when you are online.' : 'You are invisible now.')
        : (r.error || 'that did not work'), !r.ok);
    });
  });
}());
