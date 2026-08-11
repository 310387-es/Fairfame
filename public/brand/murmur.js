/* Fairfame — "the murmur": interactive word-of-mouth background.
   The one illustration device (docs/24 §5). Faint invented phrases — never real
   review text — drift on paper; they sharpen as the pointer nears (lean in and
   you can hear the talk), and a click sends a ring through them.
   Usage: Murmur.attach(containerEl, {carve:true}) — canvas is inserted as first child.

   Two embedding options, re-applied 11 Aug 2026 after a regenerated copy of this
   file dropped them. Both are backwards compatible — the defaults are what the
   brand sheet and the landing concept already run — and the app depends on both:
     opts.family — the font-family to draw with, default "Lora". The face's name
       belongs to whatever loaded it: a bundler that hashes it (next/font has
       emitted "__Lora_<hash>") must pass its own, or the texture quietly falls
       back to Georgia — still a serif, still handsome, and nobody notices.
     the return value — {detach}. A single-page app unmounts the container while
       the tab stays open; with nothing to stop it the loop draws forever into a
       canvas nobody can see, and React's cleanup calls detach(). */
(function (global) {
  var PHRASES = [
    "tavsiye ederim","yine geleceğiz","harika ekip","çok ilgililer",
    "bayıldık","sıcacık bir yer","güler yüzlü",
    "hızlı ve özenli","kesinlikle öneririm","teşekkürler",
    "highly recommend","we'll be back","worth the visit","lovely staff",
    "they listened","spotless","quick to reply","felt looked after",
    "best in the neighbourhood","ask for the usual"
  ];
  var INK = [16, 25, 58], AMBER = [245, 165, 36];
  var instances = [];
  function attach(el, opts) {
    opts = opts || {};
    var phrases = opts.phrases || PHRASES;
    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;display:block;";
    el.insertBefore(canvas, el.firstChild);
    var ctx = canvas.getContext("2d");
    var dpr = Math.min(global.devicePixelRatio || 1, 2);
    var words = [], rings = [], mouse = { x: -9999, y: -9999 };
    var reduced = global.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    var W = 0, H = 0;
    var FACE = (opts.family || "Lora") + ", Georgia, serif";
    var raf = 0, live = true;

    var cvx = opts.carveX === undefined ? 0.5 : opts.carveX;
    var cvy = opts.carveY === undefined ? 0.5 : opts.carveY;
    function carved(x, y) {
      if (!opts.carve) return false;
      var dx = (x - W * cvx) / (W * 0.34), dy = (y - H * cvy) / (H * 0.50);
      return dx * dx + dy * dy < 1;
    }
    function seed() {
      words.length = 0;
      var target = Math.max(16, Math.round((W * H) / 26000));
      var guard = 0;
      while (words.length < target && guard++ < target * 40) {
        var x = 20 + Math.random() * (W - 40), y = 24 + Math.random() * (H - 34);
        var text = phrases[(Math.random() * phrases.length) | 0];
        var size = 12 + Math.random() * 8;
        ctx.font = "italic " + size.toFixed(1) + "px " + FACE;
        var tw = ctx.measureText(text).width;
        if (x + tw > W - 12) continue;
        if (carved(x, y) || carved(x + tw / 2, y) || carved(x + tw, y)) continue;
        var clash = false;
        for (var j = 0; j < words.length; j++) {
          var o = words[j];
          if (Math.abs(y - o.y) < 30 && x < o.x + o.tw + 26 && o.x < x + tw + 26) { clash = true; break; }
        }
        if (clash) continue;
        words.push({
          text: text, tw: tw,
          x: x, y: y,
          size: size,
          phase: Math.random() * Math.PI * 2,
          speed: 0.18 + Math.random() * 0.3,
          amp: 4 + Math.random() * 7,
          tilt: (Math.random() - 0.5) * 0.14,
          accent: Math.random() < 0.16,
          boost: 0
        });
      }
    }
    function resize() {
      var r = el.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }
    function frame(t) {
      if (!live) return;
      t = (t || 0) / 1000;
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < rings.length; i++) { rings[i].r += 2.6; rings[i].a *= 0.965; }
      rings = rings.filter(function (g) { return g.a > 0.02; });
      for (var g of rings) {
        ctx.beginPath();
        ctx.strokeStyle = "rgba(" + AMBER.join(",") + "," + (g.a * 0.5).toFixed(3) + ")";
        ctx.lineWidth = 1.4;
        ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      for (var w of words) {
        var dx = reduced ? 0 : Math.sin(t * w.speed + w.phase) * w.amp;
        var dy = reduced ? 0 : Math.cos(t * w.speed * 0.7 + w.phase) * w.amp * 0.4;
        var x = w.x + dx, y = w.y + dy;
        var md = Math.hypot(mouse.x - x, mouse.y - y);
        var near = Math.max(0, 1 - md / 150);
        for (var g2 of rings) {
          var rd = Math.abs(Math.hypot(g2.x - x, g2.y - y) - g2.r);
          if (rd < 46) w.boost = Math.max(w.boost, g2.a * (1 - rd / 46));
        }
        w.boost *= 0.94;
        var k = Math.max(near, w.boost);
        var base = w.accent ? 0.34 : 0.10;
        var alpha = base + (0.9 - base) * k * k;
        var col = w.accent ? AMBER : INK;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(w.tilt * (1 - k));
        ctx.font = "italic " + (w.size * (1 + 0.08 * k)).toFixed(1) + "px " + FACE;
        ctx.fillStyle = "rgba(" + col.join(",") + "," + alpha.toFixed(3) + ")";
        ctx.fillText(w.text, 0, 0);
        ctx.restore();
      }
      if (!reduced || rings.length || mouse.x > -999) raf = requestAnimationFrame(frame);
    }
    function onMove(e) {
      var r = el.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top;
    }
    function onLeave() { mouse.x = mouse.y = -9999; }
    function onDown(e) {
      var r = el.getBoundingClientRect();
      rings.push({ x: e.clientX - r.left, y: e.clientY - r.top, r: 8, a: 1 });
    }
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);
    el.addEventListener("pointerdown", onDown);
    global.addEventListener("resize", resize);
    resize(); raf = requestAnimationFrame(frame);

    var instance = { setPhrases: function (list) { phrases = list; seed(); } };
    instances.push(instance);

    return {
      detach: function () {
        live = false;
        cancelAnimationFrame(raf);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
        el.removeEventListener("pointerdown", onDown);
        global.removeEventListener("resize", resize);
        // Out of the registry too, or setPhrases() reseeds a canvas that is gone.
        var at = instances.indexOf(instance);
        if (at !== -1) instances.splice(at, 1);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  }
  function setPhrases(list) { instances.forEach(function (i) { i.setPhrases(list); }); }
  global.Murmur = { attach: attach, setPhrases: setPhrases };
})(window);
