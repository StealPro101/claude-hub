/*
 * The one ready-made prompt a friend can paste to their own Claude.
 *
 * Kept short on purpose: only what it takes to get a game that already works onto the
 * Hub. The real game is never touched (a copy is), every step is a command on the
 * GitHub account that is already signed in, and nothing here tells anybody how to
 * design their game.
 */
var HubPrompt = (function () {
  'use strict';
  function text(origin) {
    var site = origin || location.origin;
    return [
      'Put my game on the Hub (' + site + '). Do every step yourself with commands.',
      'If you do not know which game I mean, ask me.',
      '',
      '1. Do NOT change my real game. Make a copy of its folder next to it, named',
      '   <name>-hub (leave out .git and node_modules), and work only in the copy.',
      '2. In the copy, change only what it takes to load and play from a web address:',
      '   index.html at the top level, and file paths that do not start with a slash.',
      '3. Only if the game is online multiplayer with its own server program: the copy',
      '   uses the Hub\'s rooms instead. Add  <script src="' + site + '/room.js"></script>',
      '   and read the notes at the top of that file first (curl it). The host player\'s',
      '   browser does what the server did.',
      '4. Put the copy on my GitHub, on the account gh is signed in to. Tell me which',
      '   account first. If gh is missing or not signed in, stop and tell me.',
      '     git init -b main, add an empty file named .nojekyll, commit everything',
      '     gh repo create <name> --public --source=. --remote=origin --push',
      '     gh api -X POST repos/<login>/<name>/pages -f "source[branch]=main" -f "source[path]=/"',
      '     gh repo edit <login>/<name> --add-topic claude-hub-game',
      '5. Wait until  gh api repos/<login>/<name>/pages --jq .status  says built, then',
      '   open https://<login>.github.io/<name>/ and make sure the game loads.',
      '6. Never put a key, token, password or personal information in it: the repo is public.',
      '',
      'When it is done, give me the address and tell me to refresh My games > Add a game',
      'on the Hub.'
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
