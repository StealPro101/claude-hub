/*
 * The owner's panel. Everything here is a request the server checks again: if the
 * session is not one of ADMIN_GITHUB_IDS, every call comes back "not for you".
 */
(function () {
  'use strict';
  var state = null;

  function say(id, text, bad) {
    var n = document.getElementById(id);
    if (!n) return;
    n.textContent = text || '';
    n.className = 'msg ' + (bad ? 'bad' : 'ok');
  }

  function nope(why) {
    Hub.show('nope', true);
    Hub.show('panel', false);
    document.getElementById('nopeWhy').textContent = why;
  }

  function act(path, body, msgId) {
    Hub.post(path, body || {}).then(function (r) {
      if (r.ok) {
        say(msgId, 'done');
        load();
      } else {
        say(msgId, r.error || 'that did not work', true);
      }
    });
  }

  function button(label, fn, plain) {
    var b = Hub.el('button', 'btn btn--sm' + (plain ? ' btn--plain' : ''), label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function cell(row, text, cls) {
    var td = Hub.el('td', cls || '', text);
    row.appendChild(td);
    return td;
  }

  Hub.bar('admin', null);

  function load() {
    fetch('/api/admin/state', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, body: j }; });
      })
      .then(function (res) {
        if (res.status === 401) {
          nope('Sign in first — and only the Hub owner gets in here.');
          return;
        }
        if (res.status !== 200 || !res.body.ok) {
          nope((res.body && res.body.error) || 'This panel belongs to the Hub owner.');
          return;
        }
        state = res.body;
        Hub.show('nope', false);
        Hub.show('panel', true);
        draw();
      })
      .catch(function () { nope('Could not reach the Hub right now.'); });
  }

  Hub.data().then(function (d) {
    Hub.bar('admin', d);
    if (!d.me) {
      nope('Sign in first — and only the Hub owner gets in here.');
      return;
    }
    if (!d.me.admin) {
      nope('This panel belongs to the Hub owner. Nothing here works for anyone else.');
      return;
    }
    load();
  }).catch(function () { nope('Could not reach the Hub right now.'); });

  function draw() {
    var s = state.settings;
    document.getElementById('rNum').value = s.round.round;
    document.getElementById('rCat').value = s.round.category || '';
    document.getElementById('rNote').value = s.round.note || '';
    document.getElementById('headline').textContent =
      state.members.length + ' members · ' + state.games.length + ' games · ' +
      state.games.filter(function (g) { return g.status === 'draft'; }).length + ' drafts';

    document.getElementById('invState').textContent = s.inviteRequired
      ? 'Invite-only is on. A new person needs this link.'
      : 'Invite-only is OFF — anyone with a GitHub account can sign in.';
    document.getElementById('invLink').value = location.origin + '/join?code=' + s.inviteCode;

    document.getElementById('refState').textContent = s.lastRefresh
      ? 'Last refresh ' + Hub.ago(s.lastRefresh) + ' (' + s.lastRefresh + ')'
      : 'No refresh has run yet.';

    /* games */
    var gBox = document.getElementById('games');
    Hub.clear(gBox);
    if (!state.games.length) {
      var none = Hub.el('tr');
      var td = Hub.el('td', 'muted', 'No member games yet.');
      td.colSpan = 4;
      none.appendChild(td);
      gBox.appendChild(none);
    }
    state.games.forEach(function (g) {
      var tr = Hub.el('tr');
      var first = Hub.el('td');
      first.appendChild(Hub.el('div', '', g.title || 'Untitled'));
      first.appendChild(Hub.el('div', 'mono', g.id));
      tr.appendChild(first);
      cell(tr, g.owner);
      var bits = [g.status === 'draft' ? 'draft' : 'published'];
      if (g.hidden) bits.push('hidden');
      if (g.featured) bits.push('pick');
      if (g.cover) bits.push('cover');
      bits.push(g.source);
      cell(tr, bits.join(' · '), 'mono');
      var acts = Hub.el('td');
      var box = Hub.el('div', 'acts');
      if (g.status !== 'draft') {
        box.appendChild(button('Unpublish', function () {
          act('/api/admin/game/unpublish', { id: g.id }, 'gMsg');
        }));
      }
      box.appendChild(button(g.hidden ? 'Unhide' : 'Hide', function () {
        act('/api/admin/game/hide', { id: g.id, on: !g.hidden }, 'gMsg');
      }));
      box.appendChild(button(g.featured ? 'Unfeature' : 'Feature', function () {
        act('/api/admin/game/feature', { id: g.id, on: !g.featured }, 'gMsg');
      }));
      if (g.cover) {
        box.appendChild(button('Remove picture', function () {
          act('/api/admin/game/cover-remove', { id: g.id }, 'gMsg');
        }, true));
      }
      box.appendChild(button('Remove', function () {
        act('/api/admin/game/remove', { id: g.id }, 'gMsg');
      }, true));
      acts.appendChild(box);
      tr.appendChild(acts);
      gBox.appendChild(tr);
    });

    /* house games - the owner is the only one who can touch them */
    var hBox = document.getElementById('house');
    Hub.clear(hBox);
    (state.house || []).forEach(function (g) {
      var slug = g.id.slice('house/'.length);
      var tr = Hub.el('tr');
      var first = Hub.el('td');
      first.appendChild(Hub.el('div', 'mono', g.id));
      tr.appendChild(first);
      var nameTd = Hub.el('td');
      var name = document.createElement('input');
      name.type = 'text';
      name.maxLength = 60;
      name.value = g.title || '';
      name.setAttribute('aria-label', 'Name of ' + g.id);
      nameTd.appendChild(name);
      tr.appendChild(nameTd);
      var catTd = Hub.el('td');
      var cat = document.createElement('input');
      cat.type = 'text';
      cat.maxLength = 40;
      cat.value = g.category || '';
      cat.setAttribute('aria-label', 'Category of ' + g.id);
      catTd.appendChild(cat);
      tr.appendChild(catTd);
      var acts = Hub.el('td');
      var box = Hub.el('div', 'acts');
      box.appendChild(button('Save', function () {
        act('/api/admin/house/meta', {
          slug: slug, title: name.value, description: g.description, category: cat.value
        }, 'hMsg');
      }));
      if (g.cover) {
        box.appendChild(button('Remove picture', function () {
          act('/api/admin/game/cover-remove', { id: g.id }, 'hMsg');
        }, true));
      }
      acts.appendChild(box);
      tr.appendChild(acts);
      hBox.appendChild(tr);
    });

    /* members */
    var mBox = document.getElementById('members');
    Hub.clear(mBox);
    state.members.forEach(function (m) {
      var tr = Hub.el('tr');
      var who = Hub.el('td');
      who.appendChild(Hub.el('div', '', m.name || m.login));
      who.appendChild(Hub.el('div', 'mono', '@' + m.login + (m.gone ? ' · account gone' : '')));
      tr.appendChild(who);
      cell(tr, m.id, 'mono');
      cell(tr, m.joined || '', 'mono');
      var acts = Hub.el('td');
      var box = Hub.el('div', 'acts');
      box.appendChild(button('Remove', function () {
        act('/api/admin/member/remove', { id: m.id }, 'mMsg');
      }, true));
      box.appendChild(button('Ban', function () {
        act('/api/admin/member/ban', { id: m.id }, 'mMsg');
      }, true));
      acts.appendChild(box);
      tr.appendChild(acts);
      mBox.appendChild(tr);
    });

    /* bans */
    var bBox = document.getElementById('bans');
    Hub.clear(bBox);
    if (!state.bans.length) {
      var row = Hub.el('tr');
      var td2 = Hub.el('td', 'muted', 'Nobody is banned.');
      td2.colSpan = 4;
      row.appendChild(td2);
      bBox.appendChild(row);
    }
    state.bans.forEach(function (b) {
      var tr = Hub.el('tr');
      cell(tr, b.login || String(b.id));
      cell(tr, b.id, 'mono');
      cell(tr, (b.at || '').slice(0, 10), 'mono');
      var acts = Hub.el('td');
      var box = Hub.el('div', 'acts');
      box.appendChild(button('Unban', function () {
        act('/api/admin/member/unban', { id: b.id }, 'mMsg');
      }));
      acts.appendChild(box);
      tr.appendChild(acts);
      bBox.appendChild(tr);
    });

    /* log */
    var log = document.getElementById('log');
    Hub.clear(log);
    if (!state.log.length) log.appendChild(Hub.el('div', 'muted', 'Nothing has happened yet.'));
    state.log.forEach(function (e) {
      var line = Hub.el('div');
      line.appendChild(Hub.el('span', '', (e.at || '').replace('T', ' ').slice(0, 16) + '  '));
      var what = Hub.el('b', '', e.what);
      line.appendChild(what);
      line.appendChild(Hub.el('span', '', '  ' + e.who + '  ' + (e.detail || '')));
      log.appendChild(line);
    });
  }

  document.getElementById('rSave').addEventListener('click', function () {
    act('/api/admin/round', {
      round: Number(document.getElementById('rNum').value),
      category: document.getElementById('rCat').value,
      note: document.getElementById('rNote').value
    }, 'rMsg');
  });

  document.getElementById('invToggle').addEventListener('click', function () {
    act('/api/admin/invite', { required: !(state && state.settings.inviteRequired) }, 'invMsg');
  });

  document.getElementById('invNew').addEventListener('click', function () {
    act('/api/admin/invite', { newCode: true }, 'invMsg');
  });

  document.getElementById('invCopy').addEventListener('click', function () {
    var box = document.getElementById('invLink');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.value).then(function () {
        say('invMsg', 'Join link copied.');
      }, function () {
        say('invMsg', 'Select the link and copy it.', true);
      });
    } else {
      box.select();
      say('invMsg', 'Select the link and copy it.');
    }
  });

  document.getElementById('refNow').addEventListener('click', function () {
    say('refMsg', 'asking GitHub…');
    Hub.post('/api/admin/refresh', {}).then(function (r) {
      if (!r.ok) {
        say('refMsg', r.error || 'refresh failed', true);
        return;
      }
      var s = r.summary;
      say('refMsg', 'checked ' + s.checked + ' of ' + s.members + ' members, added ' + s.added +
        ', removed ' + s.removed + ', updated ' + s.updated + ', ' + s.used + ' GitHub calls.');
      load();
    });
  });
}());
