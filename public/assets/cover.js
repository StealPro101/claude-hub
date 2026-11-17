/*
 * The cover cropper.
 *
 * A picture comes in from the file picker (a phone offers the photo library), a drop
 * or a paste. It is drawn into a 960x600 canvas - 16:10, the same shape as every cover
 * on the Hub - and the person drags it around to choose what shows. Arrow keys work too.
 *
 * Re-drawing through a canvas is also what drops everything the camera wrote into the
 * file: no EXIF, so no date, no camera, and above all no GPS location travels with the
 * picture. Only the pixels inside the frame are ever uploaded.
 */
var Cover = (function () {
  'use strict';

  var W = 960;
  var H = 600;
  var TARGET = 180 * 1024;

  function supportsWebp() {
    try {
      var c = document.createElement('canvas');
      c.width = 1;
      c.height = 1;
      return c.toDataURL('image/webp').indexOf('data:image/webp') === 0;
    } catch (e) {
      return false;
    }
  }

  function make(opts) {
    var box = opts.box;
    var canvas = opts.canvas;
    var emptyNote = opts.empty;
    var onChange = opts.onChange || function () {};
    var ctx = canvas.getContext('2d');
    var img = null;
    var scale = 1;
    var minScale = 1;
    var ox = 0;
    var oy = 0;
    var dirty = false;

    function clamp() {
      var w = img.naturalWidth * scale;
      var h = img.naturalHeight * scale;
      ox = Math.min(0, Math.max(W - w, ox));
      oy = Math.min(0, Math.max(H - h, oy));
    }

    function draw() {
      if (!img) return;
      ctx.fillStyle = '#0e0e0d';
      ctx.fillRect(0, 0, W, H);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, ox, oy, img.naturalWidth * scale, img.naturalHeight * scale);
    }

    function load(file) {
      if (!file || !/^image\//.test(file.type)) {
        onChange({ error: 'that is not a picture' });
        return;
      }
      if (file.size > 25 * 1024 * 1024) {
        onChange({ error: 'that picture is enormous, try a smaller one' });
        return;
      }
      var url = URL.createObjectURL(file);
      var next = new Image();
      next.onload = function () {
        URL.revokeObjectURL(url);
        img = next;
        minScale = Math.max(W / img.naturalWidth, H / img.naturalHeight);
        scale = minScale;
        ox = (W - img.naturalWidth * scale) / 2;
        oy = (H - img.naturalHeight * scale) / 2;
        dirty = true;
        canvas.classList.remove('off');
        if (emptyNote) emptyNote.classList.add('off');
        draw();
        onChange({ ready: true });
      };
      next.onerror = function () {
        URL.revokeObjectURL(url);
        onChange({ error: 'that picture could not be opened' });
      };
      next.src = url;
    }

    function move(dx, dy) {
      if (!img) return;
      ox += dx;
      oy += dy;
      clamp();
      draw();
      dirty = true;
    }

    /* drag with mouse, pen or finger */
    var dragging = false;
    var lastX = 0;
    var lastY = 0;
    box.addEventListener('pointerdown', function (ev) {
      if (!img) return;
      dragging = true;
      lastX = ev.clientX;
      lastY = ev.clientY;
      box.setPointerCapture(ev.pointerId);
    });
    box.addEventListener('pointermove', function (ev) {
      if (!dragging) return;
      var k = W / box.clientWidth;
      move((ev.clientX - lastX) * k, (ev.clientY - lastY) * k);
      lastX = ev.clientX;
      lastY = ev.clientY;
    });
    box.addEventListener('pointerup', function () { dragging = false; });
    box.addEventListener('pointercancel', function () { dragging = false; });

    box.addEventListener('keydown', function (ev) {
      var step = ev.shiftKey ? 60 : 20;
      var dx = ev.key === 'ArrowLeft' ? -step : ev.key === 'ArrowRight' ? step : 0;
      var dy = ev.key === 'ArrowUp' ? -step : ev.key === 'ArrowDown' ? step : 0;
      if (!dx && !dy) return;
      ev.preventDefault();
      move(dx, dy);
    });

    /* drop and paste */
    ['dragenter', 'dragover'].forEach(function (name) {
      box.addEventListener(name, function (ev) {
        ev.preventDefault();
        box.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      box.addEventListener(name, function () { box.classList.remove('over'); });
    });
    box.addEventListener('drop', function (ev) {
      ev.preventDefault();
      if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) {
        load(ev.dataTransfer.files[0]);
      }
    });
    window.addEventListener('paste', function (ev) {
      if (!ev.clipboardData) return;
      var items = ev.clipboardData.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image/') === 0) {
          load(items[i].getAsFile());
          return;
        }
      }
    });

    /* squeeze until it fits in the budget */
    function toBlob(type, quality) {
      return new Promise(function (done) {
        canvas.toBlob(function (b) { done(b); }, type, quality);
      });
    }

    async function exportBlob() {
      if (!img) return null;
      var type = supportsWebp() ? 'image/webp' : 'image/jpeg';
      var qualities = [0.88, 0.78, 0.68, 0.58, 0.48, 0.38];
      for (var i = 0; i < qualities.length; i++) {
        var blob = await toBlob(type, qualities[i]);
        if (blob && blob.size <= TARGET) return { blob: blob, type: type };
        if (i === qualities.length - 1 && blob) return { blob: blob, type: type };
      }
      return null;
    }

    function reset() {
      img = null;
      dirty = false;
      canvas.classList.add('off');
      if (emptyNote) emptyNote.classList.remove('off');
      ctx.clearRect(0, 0, W, H);
    }

    return {
      load: load,
      reset: reset,
      exportBlob: exportBlob,
      has: function () { return Boolean(img); },
      changed: function () { return dirty; },
      clean: function () { dirty = false; }
    };
  }

  return { make: make, W: W, H: H };
}());
