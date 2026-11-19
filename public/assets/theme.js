/*
 * Light or dark, decided before anything is drawn.
 *
 * This runs in the <head>, ahead of the stylesheet, so a dark page never flashes white
 * on its way in. It knows nothing about the rest of the site and needs nothing from it.
 *
 *   localStorage.hubTheme = 'light' | 'dark' | 'auto'   ('auto' follows the device)
 *   window.HubTheme.get() / .set(value)
 *
 * The choice is kept in this browser only - there is nothing to tell the server, and
 * nothing it could do with it.
 */
(function () {
  'use strict';
  var KEY = 'hubTheme';
  var root = document.documentElement;
  var mq = null;
  try {
    mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  } catch (e) {
    mq = null;
  }

  /* anything unexpected, or storage that will not answer, means light */
  function chosen() {
    try {
      var v = localStorage.getItem(KEY);
      return (v === 'light' || v === 'dark' || v === 'auto') ? v : 'light';
    } catch (e) {
      return 'light';
    }
  }

  function resolve(v) {
    if (v === 'dark') return 'dark';
    if (v === 'auto') return (mq && mq.matches) ? 'dark' : 'light';
    return 'light';
  }

  function apply(v) {
    root.dataset.theme = resolve(v);
  }

  apply(chosen());

  /* while it is on "match my device", the device may change its mind at any time */
  if (mq) {
    var follow = function () {
      if (chosen() === 'auto') apply('auto');
    };
    if (mq.addEventListener) mq.addEventListener('change', follow);
    else if (mq.addListener) mq.addListener(follow);
  }

  window.HubTheme = {
    get: function () { return chosen(); },
    set: function (v) {
      var want = (v === 'dark' || v === 'auto') ? v : 'light';
      try {
        localStorage.setItem(KEY, want);
      } catch (e) { /* this page still changes, the next one starts light */ }
      apply(want);
      return want;
    }
  };
}());
