/* Add / remove your own games. The server re-checks that every repo is really yours. */
(function () {
  'use strict';
  var me = null;
  var mineBox = document.getElementById('mine');
  var reposBox = document.getElementById('repos');
  var msg = document.getElementById('mineMsg');

  function show(id, on) {
    var n = document.getElementById(id);
    if (n) n.classList.toggle('off', !on);
  }

  function say(text, bad) {
    msg.textContent = text || '';
    msg.className = 'msg ' + (bad ? 'bad' : 'ok');
  }

  Hub.nav('mygames', null);

  Hub.data().then(function (d) {
    me = d.me;
    Hub.nav('mygames', me);
    if (!me) {
      show('signedOut', true);
      return;
    }
    var member = null;
    for (var i = 0; i < (d.members || []).length; i++) {
      if (d.members[i].id === me.id) member = d.members[i];
    }
    show('who', true);
    show('onHub', true);
    show('pick', true);
    show('lazy', true);
    document.getElementById('meAv').src = Hub.avatarUrl(member && member.avatar, me.id);
    document.getElementById('meName').textContent = (member && member.name) || me.login;
    document.getElementById('meLogin').textContent = '@' + me.login;
    HubPrompt.mount('prompt', 'copy', 'copyMsg');
    drawMine(d);
    loadRepos();
  }).catch(function () {
    show('signedOut', true);
  });

  function drawMine(d) {
    var low = String(me.login).toLowerCase();
    var mine = (d.games || []).filter(function (g) {
      return !g.legacy && String(g.owner).toLowerCase() === low;
    });
    Hub.clear(mineBox);
    if (!mine.length) {
      mineBox.appendChild(Hub.el('div', 'mini', 'Nothing yet. Pick a repo below, or tag one with the topic.'));
      return;
    }
    for (var i = 0; i < mine.length; i++) {
      (function (g) {
        var row = Hub.el('div', 'item');
        var box = Hub.el('div');
        box.appendChild(Hub.el('div', 'name', (g.emoji || '') + ' ' + g.title));
        box.appendChild(Hub.el('div', 'sub', g.id + ' · ' + g.category));
        row.appendChild(box);
        var acts = Hub.el('div', 'acts');
        var play = Hub.el('a', 'btn alt sm', 'play');
        play.href = '/play.html?g=' + encodeURIComponent(g.id);
        acts.appendChild(play);
        var rm = Hub.el('button', 'btn alt sm', 'remove');
        rm.type = 'button';
        rm.addEventListener('click', function () {
          rm.disabled = true;
          var repo = g.id.slice(g.id.indexOf('/') + 1);
          Hub.post('/api/games/remove', { repo: repo }).then(function (r) {
            if (r.ok) {
              say('Removed ' + g.id + '. It stays off until you add it again.');
              reload();
            } else {
              say(r.error || 'could not remove that', true);
              rm.disabled = false;
            }
          });
        });
        acts.appendChild(rm);
        row.appendChild(acts);
        mineBox.appendChild(row);
      }(mine[i]));
    }
  }

  function reload() {
    Hub.data(true).then(function (d) {
      drawMine(d);
      loadRepos();
    });
  }

  function loadRepos() {
    fetch('/api/my/repos', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        Hub.clear(reposBox);
        if (!j.ok) {
          reposBox.appendChild(Hub.el('div', 'mini', j.error || 'GitHub did not answer.'));
          return;
        }
        if (!j.repos.length) {
          reposBox.appendChild(Hub.el('div', 'mini',
            'No eligible repos yet. Make a public repo with your game in index.html and turn GitHub Pages on.'));
          return;
        }
        reposBox.appendChild(Hub.el('div', 'mini',
          j.used + ' of ' + j.limit + ' game slots used.'));
        for (var i = 0; i < j.repos.length; i++) {
          (function (r) {
            var row = Hub.el('div', 'item');
            var box = Hub.el('div');
            box.appendChild(Hub.el('div', 'name', r.repo));
            var bits = [];
            if (r.topic) bits.push('has the topic');
            if (r.stars) bits.push(r.stars + ' stars');
            if (r.updated) bits.push('updated ' + Hub.ago(r.updated));
            box.appendChild(Hub.el('div', 'sub', bits.join(' · ') || 'ready'));
            if (r.description) box.appendChild(Hub.el('div', 'sub', r.description));
            row.appendChild(box);
            var acts = Hub.el('div', 'acts');
            if (r.onHub) {
              acts.appendChild(Hub.el('span', 'badge', 'on the hub'));
            } else {
              var add = Hub.el('button', 'btn sm', 'add');
              add.type = 'button';
              add.addEventListener('click', function () {
                add.disabled = true;
                Hub.post('/api/games/add', { repo: r.repo }).then(function (res) {
                  if (res.ok) {
                    say('Added ' + res.game.id + '.');
                    reload();
                  } else {
                    say(res.error || 'could not add that', true);
                    add.disabled = false;
                  }
                });
              });
              acts.appendChild(add);
            }
            row.appendChild(acts);
            reposBox.appendChild(row);
          }(j.repos[i]));
        }
      })
      .catch(function () {
        Hub.clear(reposBox);
        reposBox.appendChild(Hub.el('div', 'mini', 'Could not ask GitHub right now.'));
      });
  }

  var out = document.getElementById('out');
  if (out) {
    out.addEventListener('click', function () {
      Hub.post('/auth/logout', {}).then(function () { location.href = '/'; });
    });
  }
}());
