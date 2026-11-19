/*
 * The one ready-made prompt a friend can paste to their own Claude.
 *
 * It is written for a Claude that can run commands, and it asks that Claude to do every
 * step itself with the GitHub command line on the account that is already signed in:
 * no clicking through GitHub settings by hand. The list under THE GAME is the set of
 * things that really break a game once it sits in the Hub's frame on a /<repo>/ address.
 */
var HubPrompt = (function () {
  'use strict';
  function text(origin) {
    var site = origin || location.origin;
    return [
      'Put a game of mine on the Hub (' + site + '), a small games site for me and my',
      'friends. Do every step yourself with commands on this computer. Only stop where it',
      'says ASK ME.',
      '',
      'WHAT THE HUB NEEDS',
      'A public repo on MY GitHub account with the game\'s index.html at the top level and',
      'GitHub Pages switched on. The Hub then shows it to me as a draft only I can see.',
      '',
      'BEFORE YOU START',
      '- If you cannot run commands on this computer, stop and tell me to paste this into',
      '  Claude Code (the Code tab of the Claude desktop app).',
      '- Run  gh auth status . If gh is missing, install it (Windows: winget install --id',
      '  GitHub.cli   Mac: brew install gh). If it is not signed in, ASK ME to run',
      '  gh auth login --web  and wait until I say it is done.',
      '- Run  gh api user --jq .login  and tell me the account name. It has to be the',
      '  account I sign in to the Hub with. Everything goes on that account and no other.',
      '- If I have not said which game: ASK ME what game I want, or whether to use the',
      '  one already in this folder.',
      '',
      'IF THE GAME ALREADY EXISTS (you or another chat already built it and it works)',
      '- NEVER change the real game. Make a COPY of its folder next to it, named',
      '  <name>-hub (leave out .git and node_modules), and do everything in the copy: the',
      '  fixes, the repo, the uploads. The original folder stays exactly as it is.',
      '- In the copy, change only what it takes to run on the Hub (the list under THE',
      '  GAME: paths, the start page, the Leave corner). Same look, same rules, same content.',
      '- If the game needs its own server program to run (node, python, a database, its',
      '  own websocket server): GitHub only hosts files. In the copy, move that part to the',
      '  online play under MULTIPLAYER, so the host\'s browser does what the server did. If',
      '  that cannot be done without changing how the game plays, STOP and ASK ME.',
      '- Keep a short HUB-CHANGES.md in the copy listing every change you made, so the Hub',
      '  version is easy to redo when the real game gets an update.',
      '',
      'THE GAME (for a new game: these are the things that break games on the Hub)',
      '- Plain HTML, CSS and JavaScript that runs straight from the files: no build step,',
      '  no server, nothing to install.',
      '- index.html at the top level of the repo. Every path relative (assets/ship.png,',
      '  never /assets/ship.png): the game lives at /<repo>/, so a path that starts with',
      '  a slash breaks.',
      '- File names are case sensitive there: Ship.PNG and ship.png are two different files.',
      '- It plays inside a frame that fills the window: fill the whole window, redraw when',
      '  the size changes, no page scrolling, and make it work with mouse, keyboard AND',
      '  touch (friends play on phones too).',
      '- The Hub puts a round Leave button over the top-left corner: keep the top-left',
      '  100 x 100 pixels free of buttons, scores and anything a player must read.',
      '- No sound before the first click or key press (browsers block it). No alert(),',
      '  confirm() or prompt() boxes. No links that leave the game.',
      '- Save progress in localStorage, under keys that start with the repo name.',
      '- Keep it smooth: one requestAnimationFrame loop, movement scaled by the time',
      '  between frames, and pictures and sounds loaded before the game starts.',
      '',
      'MULTIPLAYER',
      '- Same device (two players on one keyboard, or pass the phone) always works: offer',
      '  it whenever it fits the game.',
      '- Online: there is no game server. Use PeerJS (MIT licence). Put a copy of',
      '  peerjs.min.js in the repo with its licence line; do not load it from another site.',
      '  One player presses Host and gets a short room code (peer id "<repo>-<CODE>"), the',
      '  others type the code. The host decides what happens and sends the state to everyone.',
      '- Always show what is going on: "Connecting...", after 10 seconds "Could not connect,',
      '  try again", and a clear message when a player drops. Never a blank or frozen screen.',
      '',
      'PUT IT ON GITHUB',
      '1. In the game folder:  git init -b main  (if it is not a repo yet), add an empty',
      '   file named .nojekyll, and commit everything.',
      '2. gh repo create <name> --public --source=. --remote=origin --push',
      '   (<name> = short, lowercase, dashes; a new repo, never a fork)',
      '3. gh api -X POST repos/<login>/<name>/pages -f "source[branch]=main" -f "source[path]=/"',
      '4. gh repo edit <login>/<name> --add-topic claude-hub-game',
      '5. Check  gh api repos/<login>/<name>/pages --jq .status  every 20 seconds until it',
      '   says built (give it up to 5 minutes; if it says errored, read the build log, fix, push).',
      '6. Load https://<login>.github.io/<name>/ yourself and make sure it answers and that',
      '   every file index.html asks for is there. A missing file means a wrong path: fix it',
      '   and push again.',
      '',
      'UPDATING LATER',
      'Change the files (in the -hub copy, if there is one), commit, git push. The Hub plays',
      'the new version by itself a few minutes later; nothing has to be done on the Hub.',
      '',
      'NEVER',
      '- No key, token, password or personal information in the game, the repo or the',
      '  commits. The repo is public.',
      '- No game, art, music or code copied from someone else unless its licence allows it',
      '  (keep the licence notice).',
      '- Nothing hateful or sexual, and nothing that asks a player for a login, an account',
      '  or money.',
      '',
      'WHEN YOU ARE DONE',
      'Tell me the play address, where the untouched original and the -hub copy are (if you',
      'made one) and what you changed in the copy, and that the game is now waiting as a draft on the',
      'Hub: I refresh My games > Add a game and it is in the list (it also turns up by',
      'itself within 15 minutes). There I give it a name, a description and a cover',
      'picture and press Publish.'
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
