/* Carries the invite code from /join?code=XXXX into the sign-in link. */
(function () {
  'use strict';
  Hub.nav('signin', null);
  Hub.data().then(function (d) {
    Hub.nav(d.me ? 'mygames' : 'signin', d.me);
    if (d.me) {
      var msg = document.getElementById('codeMsg');
      msg.className = 'msg ok';
      msg.textContent = 'You are signed in as @' + d.me.login + '. Your games are on the MY GAMES page.';
      var btn = document.getElementById('signin');
      btn.textContent = '🎮 MY GAMES';
      btn.href = '/mygames.html';
    }
  }).catch(function () { /* the page still works signed out */ });

  var code = '';
  try {
    code = (new URLSearchParams(location.search).get('code') || '').trim().toUpperCase();
  } catch (e) {
    code = '';
  }
  var msg = document.getElementById('codeMsg');
  var btn = document.getElementById('signin');
  if (/^[A-Z0-9]{4,16}$/.test(code)) {
    btn.href = '/auth/login?code=' + encodeURIComponent(code);
    msg.className = 'msg ok';
    msg.textContent = 'Invite link spotted — press the button and you are in.';
  } else {
    msg.className = 'msg';
    msg.textContent = 'No invite link? The Hub is just for friends, so ask for one first.';
  }

  HubPrompt.mount('prompt', 'copy', 'copyMsg');
}());
