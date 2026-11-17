/*
 * The owner's panel. Everything here is a request the server checks again: if the
 * session is not one of ADMIN_GITHUB_IDS, every call comes back "not for you".
 */
(function () {
  'use strict';
  var state = null;

  function show(id, on) {
    var n = document.getElementById(id);
    if (n) n.classList.toggle('off', !on);
  }

  function say(id, text, bad) {
    var n = document.getElementById(id);
    if (!n) return;
    n.textContent = text || '';
    n.className = 'msg ' + (bad ? 'bad' : 'ok');
  }

  function act(path, body, msgId, after) {
    Hub.post(path, body || {}).then(function (r) {
      if (r.ok) {
        say(msgId, 'done');
        load(after);
      } else {
        say(msgId, r.error || 'that did not work', true);
      }
    });
  }

  Hub.nav('admin', null);

  function nope(why) {
    show('nope', true);
    show('panel', false);
    document.getElementById('nopeWhy').textContent = why;
  }

  function load(after) {
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
          nope((res.body && res.body.error) || 'This panel is the Hub owner’s.');
          return;
        }
        state = res.body;
        show('nope', false);
        show('panel', true);
        draw();
        if (after) after();
      })
      .catch(function () {
        nope('Could not reach the Hub right now.');
      });
  }

  /* Ask who we are first, so a signed-out visitor never pokes the admin endpoint. */
  Hub.data().then(function (d) {
    Hub.nav('admin', d.me);
    if (!d.me) {
      nope('Sign in first — and only the Hub owner gets in here.');
      return;
    }
    if (!d.me.admin) {
      nope('This panel is the Hub owner’s. Nothing here works for anyone else.');
      return;
    }
    load();
  }).catch(function () {
    nope('Could not reach the Hub right now.');
  });

  function draw() {
    var s = state.settings;
    document.getElementById('rNum').value = s.round.round;
    document.getElementById('rCat').value = s.round.category || '';
    document.getElementById('rNote').value = s.round.note || '';

    document.getElementById('invState').textContent = s.inviteRequired
      ? 'Invite-only is ON. A new person needs this link.'
      : 'Invite-only is OFF - anyone with a GitHub account can sign in. Careful.';
    document.getElementById('invLink').value = location.origin + '/join?code=' + s.inviteCode;

    document.getElementById('refState').textContent = s.lastRefresh
      ? 'Last refresh ' + Hub.ago(s.lastRefresh) + ' (' + s.lastRefresh + ')'
      : 'No refresh has run yet.';

    var mbox = document.getElementById('members');
    Hub.clear(mbox);
    if (!state.members.length) mbox.appendChild(Hub.el('div', 'mini', 'Nobody has joined yet.'));
    for (var i = 0; i < state.members.length; i++) {
      (function (m) {
        var row = Hub.el('div', 'item');
        var box = Hub.el('div');
        box.appendChild(Hub.el('div', 'name', (m.name || m.login) + ' (@' + m.login + ')'));
        box.appendChild(Hub.el('div', 'sub', 'id ' + m.id + ' · joined ' + (m.joined || '?')));
        row.appendChild(box);
        var acts = Hub.el('div', 'acts');
        var rm = Hub.el('button', 'btn alt sm', 'remove');
        rm.type = 'button';
        rm.addEventListener('click', function () {
          act('/api/admin/member/remove', { id: m.id }, 'mMsg');
        });
        var ban = Hub.el('button', 'btn alt sm', 'ban');
        ban.type = 'button';
        ban.addEventListener('click', function () {
          act('/api/admin/member/ban', { id: m.id }, 'mMsg');
        });
        acts.appendChild(rm);
        acts.appendChild(ban);
        row.appendChild(acts);
        mbox.appendChild(row);
      }(state.members[i]));
    }

    var gbox = document.getElementById('games');
    Hub.clear(gbox);
    if (!state.games.length) gbox.appendChild(Hub.el('div', 'mini', 'No member games yet.'));
    for (var j = 0; j < state.games.length; j++) {
      (function (g) {
        var row = Hub.el('div', 'item');
        var box = Hub.el('div');
        box.appendChild(Hub.el('div', 'name', (g.emoji || '') + ' ' + g.title));
        box.appendChild(Hub.el('div', 'sub', g.id + ' · ' + g.category + ' · ' + g.source +
          (g.hidden ? ' · HIDDEN' : '') + (g.featured ? ' · PICK' : '')));
        row.appendChild(box);
        var acts = Hub.el('div', 'acts');
        var hide = Hub.el('button', 'btn alt sm', g.hidden ? 'unhide' : 'hide');
        hide.type = 'button';
        hide.addEventListener('click', function () {
          act('/api/admin/game/hide', { id: g.id, on: !g.hidden }, 'gMsg');
        });
        var feat = Hub.el('button', 'btn alt sm', g.featured ? 'unfeature' : 'feature');
        feat.type = 'button';
        feat.addEventListener('click', function () {
          act('/api/admin/game/feature', { id: g.id, on: !g.featured }, 'gMsg');
        });
        var rm = Hub.el('button', 'btn alt sm', 'remove');
        rm.type = 'button';
        rm.addEventListener('click', function () {
          act('/api/admin/game/remove', { id: g.id }, 'gMsg');
        });
        acts.appendChild(hide);
        acts.appendChild(feat);
        acts.appendChild(rm);
        row.appendChild(acts);
        gbox.appendChild(row);
      }(state.games[j]));
    }

    var bbox = document.getElementById('bans');
    Hub.clear(bbox);
    if (!state.bans.length) bbox.appendChild(Hub.el('div', 'mini', 'Nobody is banned.'));
    for (var k = 0; k < state.bans.length; k++) {
      (function (b) {
        var row = Hub.el('div', 'item');
        var box = Hub.el('div');
        box.appendChild(Hub.el('div', 'name', b.login || String(b.id)));
        box.appendChild(Hub.el('div', 'sub', 'id ' + b.id + ' · ' + (b.at || '')));
        row.appendChild(box);
        var un = Hub.el('button', 'btn alt sm', 'unban');
        un.type = 'button';
        un.addEventListener('click', function () {
          act('/api/admin/member/unban', { id: b.id }, 'mMsg');
        });
        var acts = Hub.el('div', 'acts');
        acts.appendChild(un);
        row.appendChild(acts);
        bbox.appendChild(row);
      }(state.bans[k]));
    }

    var log = document.getElementById('log');
    Hub.clear(log);
    if (!state.log.length) log.appendChild(Hub.el('div', 'mini', 'Nothing has happened yet.'));
    for (var n = 0; n < state.log.length; n++) {
      var e = state.log[n];
      log.appendChild(Hub.el('div', '', e.at + '  ' + e.what + '  ' + e.who + '  ' + (e.detail || '')));
    }
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
