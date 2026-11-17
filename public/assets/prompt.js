/* The one ready-made prompt a friend can paste to their own Claude. */
var HubPrompt = (function () {
  'use strict';
  function text(origin) {
    var site = origin || location.origin;
    return [
      'I want to put a game on Claude Hub (' + site + '). Do all of this on MY OWN GitHub',
      'account, using my own git / gh sign-in - never your own and never anyone else’s:',
      '',
      '1. Make a NEW PUBLIC repo on my account (not a fork), short lowercase name.',
      '2. Put my game in it as index.html in the repo ROOT (other files are fine, but',
      '   index.html has to be at the root so the page loads on its own).',
      '3. Optional hub.json in the root, all fields optional:',
      '   { "title": "max 60 chars", "description": "max 200 chars",',
      '     "category": "arcade|puzzle|action|shooter|platformer|racing|strategy|trivia|idle|horror|sandbox|sports|card|rhythm|freestyle",',
      '     "emoji": "one emoji" }',
      '4. Turn on GitHub Pages: Settings > Pages > Deploy from a branch > my default',
      '   branch > / (root). Wait for the first build to finish.',
      '5. Add the repo topic  claude-hub-game  (gear next to "About" on the repo page).',
      '6. Tell me the play address: https://<my-login>.github.io/<repo>/',
      '',
      'Hard rules while you do it:',
      '- NEVER put a key, token, password, API secret or personal information in the game,',
      '  the repo, the commits or hub.json. Nothing that is not meant to be public.',
      '- Only my own work. No copy of someone else’s game, art, music or code without a',
      '  licence that allows it, and keep the licence notice if there is one.',
      '- Nothing hateful or sexual, nothing made to trick, scare or harm whoever plays it,',
      '  and never ask a player for a login, an account or money.',
      '- The game has to work on its own page with no server: plain HTML, CSS and JS.',
      '',
      'The Hub notices the topic by itself within 15 minutes. I can also add it by hand',
      'from the MY GAMES page on the Hub.'
    ].join('\n');
  }

  /* Wires up a textarea + copy button pair. */
  function mount(areaId, buttonId, msgId) {
    var area = document.getElementById(areaId);
    var btn = document.getElementById(buttonId);
    var msg = msgId ? document.getElementById(msgId) : null;
    if (!area || !btn) return;
    area.value = text();
    btn.addEventListener('click', function () {
      var done = function (ok) {
        if (msg) {
          msg.textContent = ok ? 'Copied. Paste it to your Claude.' : 'Select the text and copy it.';
          msg.className = 'msg ' + (ok ? 'ok' : 'bad');
        }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(area.value).then(function () { done(true); }, function () { done(false); });
      } else {
        try {
          area.select();
          done(document.execCommand('copy'));
        } catch (e) {
          done(false);
        }
      }
    });
  }

  return { text: text, mount: mount };
}());
