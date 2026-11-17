/* Just the nav, so the rules page knows whether you are signed in. */
(function () {
  'use strict';
  Hub.nav('rules', null);
  Hub.data().then(function (d) { Hub.nav('rules', d.me); }).catch(function () { /* static page */ });
}());
