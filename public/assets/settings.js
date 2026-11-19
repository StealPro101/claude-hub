/*
 * Settings: the list of sections at the left, the one you chose at the right.
 *
 *   Account      who you are here, and the ways out of this page
 *   Appearance   light, dark, or whatever this device is doing
 *   Privacy      whether anyone sees you, and your own recently played
 *
 * Signed out there is only Appearance - the theme is kept in this browser, so it works
 * for a visitor exactly as it does for a member.
 *
 * The section is in the address (#appearance), so Back and Forward walk through them.
 */
(function () {
  'use strict';
  var sections = document.getElementById('sections');
  var panel = document.getElementById('panel');
  var signedOut = document.getElementById('signedOut');
  var hub = null;
  var at = '';

  Hub.bar('settings', null);

  Hub.data().then(start).catch(function () {
    Hub.fail(panel, 'Could not reach the Hub right now. Refresh in a minute.');
  });

  function start(d) {
    hub = d;
    Hub.bar('settings', d);
    Hub.beat(null);
    if (!d.me) {
      Hub.clear(signedOut);
      Hub.show(signedOut, true);
      signedOut.appendChild(document.createTextNode(
        'Sign in to see your account and privacy settings. '));
      var a = Hub.el('a', 'btn btn--sm', 'Sign in');
      a.href = '/auth/login';
      signedOut.appendChild(a);
    }
    route();
    window.addEventListener('hashchange', route);
  }

  function list() {
    return hub.me
      ? [['account', 'Account'], ['appearance', 'Appearance'], ['privacy', 'Privacy']]
      : [['appearance', 'Appearance']];
  }

  function route() {
    var want = '';
    try {
      want = decodeURIComponent(location.hash.replace(/^#/, '')).toLowerCase();
    } catch (e) {
      want = '';
    }
    var all = list().map(function (row) { return row[0]; });
    at = all.indexOf(want) >= 0 ? want : all[0];
    drawSide();
    drawPanel();
  }

  function go(which) {
    if (which === at) return;
    location.hash = '#' + which;
  }

  function drawSide() {
    Hub.clear(sections);
    list().forEach(function (row) {
      var b = Hub.el('button', 'mg-tab' + (row[0] === at ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', row[0] === at ? 'true' : 'false');
      b.appendChild(Hub.el('span', 'w', row[1]));
      b.addEventListener('click', function () { go(row[0]); });
      sections.appendChild(b);
    });
  }

  /* one row: what it is and why, at the left; the thing you press, at the right */
  function row(host, name, why, control) {
    var r = Hub.el('div', 'set-row');
    var left = Hub.el('div', 'set-label');
    left.appendChild(Hub.el('span', 'set-name', name));
    if (why) left.appendChild(Hub.el('span', 'set-why', why));
    r.appendChild(left);
    var right = Hub.el('div', 'set-ctl');
    if (control) right.appendChild(control);
    r.appendChild(right);
    host.appendChild(r);
    return r;
  }

  function linkBtn(label, href, newTab) {
    var a = Hub.el('a', 'btn btn--grey btn--sm', label);
    a.href = href;
    if (newTab) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    return a;
  }

  function drawPanel() {
    Hub.clear(panel);
    if (at === 'account') account();
    else if (at === 'privacy') privacy();
    else appearance();
  }

  /* ---------- account ---------- */

  function account() {
    var me = hub.me;
    var member = Hub.memberOf(hub.members, me.login) || {};
    panel.appendChild(Hub.el('h2', 'set-title', 'Account'));

    var head = Hub.el('div', 'set-head');
    var img = document.createElement('img');
    img.className = 'set-av';
    img.src = Hub.avatarUrl(member.avatar, me.id);
    img.alt = '';
    head.appendChild(img);
    var who = Hub.el('div', 'set-who');
    var line = Hub.el('div', 'set-nameline');
    line.appendChild(Hub.el('span', 'set-bigname', member.name || me.login));
    if (me.admin) line.appendChild(Hub.el('span', 'pill pill-draft', 'Admin'));
    who.appendChild(line);
    var at2 = Hub.el('div', 'set-at');
    var url = Hub.profileUrl(me.login);
    if (url) {
      var link = Hub.el('a', '', '@' + me.login);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      at2.appendChild(link);
    } else {
      at2.appendChild(Hub.el('span', '', '@' + me.login));
    }
    who.appendChild(at2);
    if (member.joined) {
      who.appendChild(Hub.el('div', 'set-joined', 'Joined ' + Hub.monthYear(member.joined)));
    }
    head.appendChild(who);
    panel.appendChild(head);

    var rows = Hub.el('div', 'set-rows');
    row(rows, 'Name and picture',
      'These come from your GitHub account. Change them there and they update here.',
      linkBtn('Open GitHub', url || 'https://github.com', true));
    row(rows, 'My profile', 'What everybody else sees of you here.',
      linkBtn('Open', '/players.html#' + encodeURIComponent(me.login)));
    row(rows, 'My games', 'Add a game, set one up, publish or take one off.',
      linkBtn('Open', '/mygames.html'));

    var out = Hub.el('button', 'btn btn--grey btn--sm', 'Sign out');
    out.type = 'button';
    out.addEventListener('click', function () {
      out.disabled = true;
      Hub.post('/auth/logout', {}).then(function () { location.href = '/'; });
    });
    row(rows, 'Sign out', 'On this device. Your games and your lists stay as they are.', out);
    panel.appendChild(rows);
  }

  /* ---------- appearance ---------- */

  var THEMES = [
    ['light', 'Light'],
    ['dark', 'Dark'],
    ['auto', 'Match my device']
  ];

  function preview(kind) {
    var box = Hub.el('span', 'tp tp-' + kind);
    box.appendChild(Hub.el('span', 'tp-bar'));
    box.appendChild(Hub.el('span', 'tp-tile'));
    box.appendChild(Hub.el('span', 'tp-tile'));
    return box;
  }

  function appearance() {
    panel.appendChild(Hub.el('h2', 'set-title', 'Appearance'));
    var r = Hub.el('div', 'set-row set-row--block');
    var left = Hub.el('div', 'set-label');
    left.appendChild(Hub.el('span', 'set-name', 'Theme'));
    left.appendChild(Hub.el('span', 'set-why', 'How this place looks on this device.'));
    r.appendChild(left);

    var group = Hub.el('div', 'theme-pick');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Theme');
    var now = window.HubTheme ? window.HubTheme.get() : 'light';
    THEMES.forEach(function (pair) {
      var card = Hub.el('label', 'theme-card');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'hubTheme';
      input.value = pair[0];
      input.checked = pair[0] === now;
      input.addEventListener('change', function () {
        if (!input.checked) return;
        if (window.HubTheme) window.HubTheme.set(pair[0]);
      });
      card.appendChild(input);
      card.appendChild(preview(pair[0]));
      var name = Hub.el('span', 'theme-name');
      name.appendChild(Hub.el('span', '', pair[1]));
      var tick = Hub.el('span', 'tick');
      tick.appendChild(Hub.icon('check', 15));
      name.appendChild(tick);
      card.appendChild(name);
      group.appendChild(card);
    });
    r.appendChild(group);
    panel.appendChild(r);
    panel.appendChild(Hub.el('p', 'set-note', 'Saved on this device.'));
  }

  /* ---------- privacy ---------- */

  function privacy() {
    panel.appendChild(Hub.el('h2', 'set-title', 'Privacy'));
    var rows = Hub.el('div', 'set-rows');
    var member = Hub.memberOf(hub.members, hub.me.login) || {};

    var wrap = Hub.el('label', 'sw');
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.id = 'showMe';
    box.checked = !member.hidePresence;
    wrap.appendChild(box);
    var track = Hub.el('span', 'sw-track');
    track.appendChild(Hub.el('span', 'sw-knob'));
    wrap.appendChild(track);
    wrap.setAttribute('aria-label', 'Show when I am online');

    var seen = row(rows, 'Show when I\'m online',
      'With this off, nobody sees you as online or playing, and nobody can join you. ' +
      'Your plays still count towards a game\'s numbers, without your name.', wrap);
    var seenMsg = Hub.el('p', 'msg', '');
    seen.appendChild(seenMsg);
    box.addEventListener('change', function () {
      Hub.post('/api/me/presence', { show: box.checked }).then(function (res) {
        seenMsg.className = 'msg ' + (res && res.ok ? 'ok' : 'bad');
        seenMsg.textContent = res && res.ok
          ? (res.show ? 'Others can see when you are online.' : 'You are invisible now.')
          : ((res && res.error) || 'that did not work');
        if (res && res.ok) member.hidePresence = !res.show;
      });
    });

    var clear = Hub.el('button', 'btn btn--grey btn--sm', 'Clear');
    clear.type = 'button';
    var cleared = row(rows, 'Recently played',
      'Only you can see this row on your home page.', clear);
    var clearMsg = Hub.el('p', 'msg', '');
    cleared.appendChild(clearMsg);
    clear.addEventListener('click', function () {
      clear.disabled = true;
      Hub.post('/api/me/recent-clear', {}).then(function (res) {
        if (res && res.ok) {
          Hub.forgetRecentHere();
          clear.textContent = 'Cleared';
          clearMsg.className = 'msg ok';
          clearMsg.textContent = 'Your recently played row is empty.';
          if (hub.me) hub.me.recent = [];
        } else {
          clear.disabled = false;
          clearMsg.className = 'msg bad';
          clearMsg.textContent = (res && res.error) || 'that did not work';
        }
      });
    });
    panel.appendChild(rows);
  }
}());
