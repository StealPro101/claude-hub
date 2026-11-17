/*
 * My games: what is still a draft, what is published, and the form that turns one into
 * the other. The server re-checks that every repo is really yours, every time.
 */
(function () {
  'use strict';
  var me = null;
  var hub = null;
  var editing = null;
  var cropper = null;

  function say(id, text, bad) {
    var n = document.getElementById(id);
    if (!n) return;
    n.textContent = text || '';
    n.className = 'msg ' + (bad ? 'bad' : 'ok');
  }

  Hub.nav('mygames', null);

  Hub.data().then(start).catch(function () { Hub.show('signedOut', true); });

  function start(d) {
    hub = d;
    me = d.me;
    Hub.nav('mygames', me);
    if (!me) {
      Hub.show('signedOut', true);
      return;
    }
    Hub.show('signedIn', true);
    var member = Hub.memberOf(d.members, me.login);
    document.getElementById('meAv').src = Hub.avatarUrl(member && member.avatar, me.id);
    document.getElementById('meLogin').textContent =
      ((member && member.name) || me.login) + ' · @' + me.login;
    HubPrompt.mount('prompt', 'copy', 'copyMsg');
    fillCategories(d);
    cropper = Cover.make({
      box: document.getElementById('crop'),
      canvas: document.getElementById('cropCanvas'),
      empty: document.getElementById('cropEmpty'),
      onChange: function (ev) {
        if (ev && ev.error) say('fMsg', ev.error, true);
        else say('fMsg', 'Drag the picture to choose what shows, then publish.');
      }
    });
    drawMine();
    loadRepos();
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
    });
  }

  function repoOf(game) {
    return game.repo || game.id.slice(game.id.indexOf('/') + 1);
  }

  function row(game) {
    var r = Hub.el('div', 'row-item');
    var who = Hub.el('div', 'who');
    var thumb = Hub.el('span', 'thumb');
    thumb.appendChild(Hub.coverNode(game));
    who.appendChild(thumb);
    var box = Hub.el('div');
    box.appendChild(Hub.el('div', 'name', game.title || 'Untitled'));
    box.appendChild(Hub.el('div', 'sub', game.id + ' · ' + (game.category || 'freestyle')));
    who.appendChild(box);
    r.appendChild(who);

    var acts = Hub.el('div', 'btn-row');
    var repo = repoOf(game);

    var setUp = Hub.el('button', 'btn btn--sm' + (game.status === 'draft' ? ' btn--go' : ''),
      game.status === 'draft' ? 'Set up & publish' : 'Edit');
    setUp.type = 'button';
    setUp.addEventListener('click', function () { openForm(game); });
    acts.appendChild(setUp);

    var play = Hub.el('a', 'btn btn--sm', game.status === 'draft' ? 'Test' : 'Play');
    play.href = '/play.html?g=' + encodeURIComponent(game.id);
    acts.appendChild(play);

    if (game.status !== 'draft') {
      var un = Hub.el('button', 'btn btn--sm', 'Unpublish');
      un.type = 'button';
      un.addEventListener('click', function () {
        un.disabled = true;
        Hub.post('/api/games/unpublish', { repo: repo }).then(function (res) {
          if (res.ok) reload('Back to a draft. Only you can see it now.');
          else {
            say('msg', res.error, true);
            un.disabled = false;
          }
        });
      });
      acts.appendChild(un);
    }

    var rm = Hub.el('button', 'btn btn--sm btn--plain', 'Remove');
    rm.type = 'button';
    rm.addEventListener('click', function () {
      rm.disabled = true;
      Hub.post('/api/games/remove', { repo: repo }).then(function (res) {
        if (res.ok) reload('Removed ' + game.id + '. Your repo is untouched.');
        else {
          say('msg', res.error, true);
          rm.disabled = false;
        }
      });
    });
    acts.appendChild(rm);

    r.appendChild(acts);
    return r;
  }

  function drawMine() {
    var all = mineOnly();
    var drafts = all.filter(function (g) { return g.status === 'draft'; });
    var live = all.filter(function (g) { return g.status !== 'draft'; });

    var dBox = document.getElementById('drafts');
    Hub.clear(dBox);
    if (!drafts.length) dBox.appendChild(Hub.el('p', 'dim', 'No drafts waiting.'));
    for (var i = 0; i < drafts.length; i++) dBox.appendChild(row(drafts[i]));

    var lBox = document.getElementById('live');
    Hub.clear(lBox);
    if (!live.length) lBox.appendChild(Hub.el('p', 'dim', 'Nothing published yet.'));
    for (var j = 0; j < live.length; j++) lBox.appendChild(row(live[j]));
  }

  function reload(message) {
    Hub.data(true).then(function (d) {
      hub = d;
      drawMine();
      loadRepos();
      if (message) say('msg', message);
    });
  }

  /* ---------- the form ---------- */

  function openForm(game) {
    editing = game;
    Hub.show('form', true);
    document.getElementById('formTitle').textContent =
      game.status === 'draft' ? 'Set up & publish' : 'Edit';
    document.getElementById('formFor').textContent = game.id;
    document.getElementById('fName').value = game.title || '';
    document.getElementById('fDesc').value = game.description || '';
    var sel = document.getElementById('fCat');
    sel.value = game.category || 'freestyle';
    if (!sel.value) sel.value = sel.options.length ? sel.options[0].value : '';
    document.getElementById('fPublish').textContent =
      game.status === 'draft' ? 'Publish' : 'Save';
    cropper.reset();
    say('fMsg', '');
    document.getElementById('form').scrollIntoView({ block: 'start' });
    document.getElementById('fName').focus();
  }

  function closeForm() {
    editing = null;
    Hub.show('form', false);
  }

  async function saveMeta() {
    var res = await Hub.post('/api/games/meta', {
      repo: repoOf(editing),
      title: document.getElementById('fName').value,
      description: document.getElementById('fDesc').value,
      category: document.getElementById('fCat').value
    });
    return res;
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

  async function finish(publish) {
    var btn = document.getElementById(publish ? 'fPublish' : 'fSave');
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
      if (publish) {
        var pub = await Hub.post('/api/games/publish', { repo: repoOf(editing) });
        if (!pub.ok) {
          say('fMsg', pub.error, true);
          return;
        }
      }
      closeForm();
      reload(publish ? 'Published. It is on the shelf now.' : 'Saved as a draft.');
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('fPublish').addEventListener('click', function () {
    finish(editing && editing.status === 'draft');
  });
  document.getElementById('fSave').addEventListener('click', function () { finish(false); });
  document.getElementById('fClose').addEventListener('click', closeForm);
  document.getElementById('file').addEventListener('change', function (ev) {
    if (ev.target.files && ev.target.files[0]) cropper.load(ev.target.files[0]);
  });
  document.getElementById('fCoverOff').addEventListener('click', function () {
    if (!editing) return;
    cropper.reset();
    Hub.post('/api/games/cover-remove', { repo: repoOf(editing) }).then(function (res) {
      if (res.ok) {
        say('fMsg', 'Picture removed.');
        reload();
      } else {
        say('fMsg', res.error, true);
      }
    });
  });

  /* ---------- adding a repo ---------- */

  function loadRepos() {
    var box = document.getElementById('repos');
    fetch('/api/my/repos', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        Hub.clear(box);
        if (!j.ok) {
          box.appendChild(Hub.el('p', 'dim', j.error || 'GitHub did not answer.'));
          return;
        }
        if (!j.repos.length) {
          box.appendChild(Hub.el('p', 'dim',
            'No repos ready yet. Make a public repo with your game in index.html and switch GitHub Pages on.'));
          return;
        }
        for (var i = 0; i < j.repos.length; i++) {
          (function (r) {
            var item = Hub.el('div', 'row-item');
            var box2 = Hub.el('div');
            box2.appendChild(Hub.el('div', 'name', r.repo));
            var bits = [];
            if (r.topic) bits.push('has the topic');
            if (r.stars) bits.push(r.stars + ' stars');
            if (r.updated) bits.push('updated ' + Hub.ago(r.updated));
            box2.appendChild(Hub.el('div', 'sub', bits.join(' · ') || 'ready'));
            item.appendChild(box2);
            var acts = Hub.el('div', 'btn-row');
            if (r.onHub) {
              acts.appendChild(Hub.el('span', 'cat', 'on the hub'));
            } else {
              var add = Hub.el('button', 'btn btn--sm', 'Add as draft');
              add.type = 'button';
              add.addEventListener('click', function () {
                add.disabled = true;
                Hub.post('/api/games/add', { repo: r.repo }).then(function (res) {
                  if (res.ok) reload('Added ' + res.game.id + ' as a draft.');
                  else {
                    say('msg', res.error, true);
                    add.disabled = false;
                  }
                });
              });
              acts.appendChild(add);
            }
            item.appendChild(acts);
            box.appendChild(item);
          }(j.repos[i]));
        }
      })
      .catch(function () {
        Hub.clear(box);
        box.appendChild(Hub.el('p', 'dim', 'Could not ask GitHub right now.'));
      });
  }

  document.getElementById('out').addEventListener('click', function () {
    Hub.post('/auth/logout', {}).then(function () { location.href = '/'; });
  });
}());
