/*
 * THE SHELF - the published games standing in a row, lifting in a wave as the pointer
 * passes. CSS 3D only: a perspective on the rail, a rotateY on each cover, and one
 * requestAnimationFrame loop that eases every item towards its target. No canvas, no
 * WebGL, no libraries.
 *
 * Pointer:  the wave follows the cursor, falling off over about three neighbours.
 * Keyboard: arrow keys walk the shelf, the focused cover stands up.
 * Touch:    no hover, so it becomes a snap strip and the centred cover is the raised one.
 * Reduced motion: a flat row, every caption shown, nothing moves.
 */
var Shelf = (function () {
  'use strict';

  var LIFT = 30;      /* how far a cover rises, px */
  var TILT = 20;      /* resting angle, degrees */
  var SPREAD = 1.7;   /* how many neighbours come along */
  var EASE = 0.16;

  function build(host, games, members, onEmpty) {
    Hub.clear(host);
    if (!games.length) {
      if (onEmpty) onEmpty(host);
      return null;
    }

    var few = games.length <= 3;
    var rail = Hub.el('div', 'shelf' + (few ? ' shelf--few' : ''));
    var track = Hub.el('div', 'shelf-track');
    rail.appendChild(track);
    host.appendChild(rail);

    var items = [];
    for (var i = 0; i < games.length; i++) {
      (function (game, index) {
        var a = Hub.el('a', 'shelf-item');
        a.href = '/play.html?g=' + encodeURIComponent(game.id);
        a.appendChild(Hub.coverNode(game));
        var cap = Hub.el('span', 'shelf-cap');
        cap.appendChild(Hub.el('span', 't', game.title || 'Untitled'));
        cap.appendChild(Hub.el('span', 'm', game.owner));
        a.appendChild(cap);
        a.setAttribute('aria-label', (game.title || 'Untitled') + ' by ' + game.owner);
        a.addEventListener('focus', function () { target = index; lit(index); });
        a.addEventListener('keydown', function (ev) {
          var step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
          if (!step) return;
          ev.preventDefault();
          var next = items[index + step];
          if (next) next.focus();
        });
        track.appendChild(a);
        items.push(a);
      }(games[i], i));
    }

    var flat = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var touch = window.matchMedia('(hover: none)').matches;
    var target = touch ? Math.floor(items.length / 2) : -99;
    var at = target;
    var running = false;
    var litIndex = -1;

    function lit(index) {
      if (index === litIndex) return;
      if (items[litIndex]) items[litIndex].classList.remove('lit');
      if (items[index]) items[index].classList.add('lit');
      litIndex = index;
    }

    function paint() {
      for (var i = 0; i < items.length; i++) {
        var d = (i - at) / SPREAD;
        var w = Math.exp(-d * d);
        if (w < 0.004) w = 0;
        var it = items[i];
        it.style.transform = 'rotateY(' + (-TILT * (1 - w)).toFixed(2) + 'deg) ' +
          'translateY(' + (-LIFT * w).toFixed(2) + 'px) ' +
          'translateZ(' + (34 * w).toFixed(2) + 'px)';
        it.style.setProperty('--lift', (LIFT * w).toFixed(2));
        it.style.zIndex = String(10 + Math.round(w * 10));
      }
    }

    function tick() {
      var d = target - at;
      at += d * EASE;
      if (Math.abs(d) < 0.002) {
        at = target;
        running = false;
      }
      paint();
      if (running) requestAnimationFrame(tick);
    }

    function nudge(next) {
      target = next;
      if (!running) {
        running = true;
        requestAnimationFrame(tick);
      }
    }

    if (flat) {
      for (var k = 0; k < items.length; k++) items[k].classList.add('lit');
      return { rail: rail, items: items };
    }

    paint();

    if (touch) {
      /* the strip: whatever sits in the middle is the one standing up */
      /* measured against the rail itself: the items are transformed, so offsetLeft lies */
      var centre = function () {
        var railBox = rail.getBoundingClientRect();
        var mid = railBox.left + railBox.width / 2;
        var best = 0;
        var bestD = Infinity;
        for (var i = 0; i < items.length; i++) {
          var b2 = items[i].getBoundingClientRect();
          var dd = Math.abs(b2.left + b2.width / 2 - mid);
          if (dd < bestD) { bestD = dd; best = i; }
        }
        nudge(best);
        lit(best);
      };
      var centreOn = function (i) {
        var railBox = rail.getBoundingClientRect();
        var b3 = items[i].getBoundingClientRect();
        rail.scrollLeft += (b3.left + b3.width / 2) - (railBox.left + railBox.width / 2);
      };
      rail.addEventListener('scroll', function () {
        if (rail._t) return;
        rail._t = requestAnimationFrame(function () {
          rail._t = 0;
          centre();
        });
      }, { passive: true });
      /* start with the first cover in the middle of the strip, not off to one side */
      setTimeout(function () {
        centreOn(0);
        centre();
      }, 60);
      return { rail: rail, items: items, centre: centre };
    }

    rail.addEventListener('pointermove', function (ev) {
      var best = 0;
      var bestD = Infinity;
      for (var i = 0; i < items.length; i++) {
        var box = items[i].getBoundingClientRect();
        var dd = Math.abs(box.left + box.width / 2 - ev.clientX);
        if (dd < bestD) { bestD = dd; best = i; }
      }
      /* a fractional position, so the wave slides between covers instead of snapping */
      var box2 = items[best].getBoundingClientRect();
      var off = (ev.clientX - (box2.left + box2.width / 2)) / box2.width;
      nudge(best + Math.max(-0.5, Math.min(0.5, off)));
      lit(best);
    });

    rail.addEventListener('pointerleave', function () {
      nudge(-99);
      lit(-1);
    });

    return { rail: rail, items: items, nudge: nudge };
  }

  return { build: build };
}());
