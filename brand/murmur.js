/* Fairfame — "the murmur": interactive word-of-mouth background.
   The one illustration device (docs/24 §5). Faint invented phrases — never real
   review text — drift on paper; they sharpen as the pointer nears (lean in and
   you can hear the talk), and a click sends a ring through them.
   Usage: Murmur.attach(containerEl, {carve:true}) — canvas is inserted as first child.

   Two embedding options, re-applied 11 Aug 2026 after a regenerated copy of this
   file dropped them. Both are backwards compatible — the defaults are what the
   brand sheet and the landing concept already run — and the app depends on both:
     opts.opacity — a multiplier on the *resting* alpha, default 1. The words
       settle at 10% ink (34% for the amber minority) and sharpen toward the
       pointer; this lifts only where they settle, so the lean-in still has
       somewhere to go. Clamped at 0.6 so no multiplier can turn the texture
       into content sitting behind the headline.

     opts.veil — soften the middle instead of clearing it, default off. Each
       word's alpha is scaled by how deep its *centre* sits in an ellipse, so a
       phrase near the content fades as a whole phrase. This is the option to
       reach for when copy sits over the field: a wash painted on top of the
       canvas clips words wherever its edge falls and leaves half a sentence
       showing, because it fades *pixels* — this fades *words*. Sized by
       opts.veilX / opts.veilY (fractions of the container, default .40/.46)
       about the same centre `carve` uses. The inner 72% of that ellipse is
       held flat, so size it to cover the copy and let the ramp fall outside.

     opts.density — a multiplier on how many phrases are seeded, default 1. The
       count is derived from the area (about one per 26,000 square pixels), so
       this is the knob for "more crowded" without touching the geometry. The
       collision spacing relaxes with it, or a denser target simply cannot be
       met and the extra words are silently dropped.

     opts.speed — a multiplier on the drift, default 1. The words move on two
       out-of-phase sines; this scales both, so the crowd stirs faster without
       travelling further.

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
    var REST = opts.opacity === undefined ? 1 : opts.opacity;
    var DENSITY = opts.density === undefined ? 1 : opts.density;
    var SPEED = opts.speed === undefined ? 1 : opts.speed;
    /* Spacing relaxes as the square root of density: the words tile a plane,
       so twice as many of them need their gaps cut by about a factor of √2 to
       fit in the same area. Floored, or a high multiplier would let phrases
       overlap into an unreadable mat. */
    var GAP = 1 / Math.sqrt(Math.max(1, DENSITY));
    var raf = 0, live = true;

    var cvx = opts.carveX === undefined ? 0.5 : opts.carveX;
    var cvy = opts.carveY === undefined ? 0.5 : opts.carveY;
    var vlx = opts.veilX === undefined ? 0.40 : opts.veilX;
    var vly = opts.veilY === undefined ? 0.46 : opts.veilY;
    /* Never quite zero: a phrase that vanishes completely at the centre and
       reappears a pixel later is the same broken edge in a different place. */
    var VEIL_FLOOR = 0.06;
    /* The veil holds *flat* across the inner 72% and only then ramps out.

       A ramp starting at the centre looks right until you notice the copy's
       corners: a text block is a rectangle inside an ellipse, so its edges sit
       far enough out that the ramp has already given most of the opacity back
       and the words there are as loud as anywhere. The core has to cover the
       block, and the transition has to happen outside it. */
    var VEIL_CORE = 0.72;
    function veil(x, y) {
      if (!opts.veil) return 1;
      var dx = (x - W * cvx) / (W * vlx), dy = (y - H * cvy) / (H * vly);
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d >= 1) return 1;
      if (d <= VEIL_CORE) return VEIL_FLOOR;
      var f = (d - VEIL_CORE) / (1 - VEIL_CORE);
      return VEIL_FLOOR + (1 - VEIL_FLOOR) * f * f;
    }
    function carved(x, y) {
      if (!opts.carve) return false;
      var dx = (x - W * cvx) / (W * 0.34), dy = (y - H * cvy) / (H * 0.50);
      return dx * dx + dy * dy < 1;
    }
    function seed() {
      words.length = 0;
      var target = Math.max(16, Math.round(((W * H) / 26000) * DENSITY));
      var guard = 0;
      /* Deal from a shuffled deck rather than picking at random.

         Independent random picks put the same sentence on screen four or five
         times out of a ten-phrase list while others never appear at all, and a
         murmur that keeps repeating itself reads as a bug rather than as a
         crowd. Dealing guarantees every phrase is used once before any is used
         twice, so the counts differ by at most one however many words fit. */
      var deck = [];
      function deal() {
        if (!deck.length) {
          deck = phrases.slice();
          for (var d = deck.length - 1; d > 0; d--) {
            var r = (Math.random() * (d + 1)) | 0, t = deck[d];
            deck[d] = deck[r]; deck[r] = t;
          }
        }
        return deck.pop();
      }
      while (words.length < target && guard++ < target * 40) {
        var x = 20 + Math.random() * (W - 40), y = 24 + Math.random() * (H - 34);
        var text = deal();
        var size = 12 + Math.random() * 8;
        ctx.font = "italic " + size.toFixed(1) + "px " + FACE;
        var tw = ctx.measureText(text).width;
        /* A rejected position returns its card. Without this a phrase can be
           dealt, fail to fit, and never appear — which is the same uneven
           distribution the deck exists to remove, arrived at more slowly. */
        if (x + tw > W - 12) { deck.push(text); continue; }
        if (carved(x, y) || carved(x + tw / 2, y) || carved(x + tw, y)) { deck.push(text); continue; }
        var clash = false;
        for (var j = 0; j < words.length; j++) {
          var o = words[j];
          if (Math.abs(y - o.y) < 30 * GAP && x < o.x + o.tw + 26 * GAP && o.x < x + tw + 26 * GAP) { clash = true; break; }
        }
        if (clash) { deck.push(text); continue; }
        words.push({
          text: text, tw: tw,
          x: x, y: y,
          /* From the middle of the phrase, and stored rather than recomputed:
             one factor for the whole word is what stops it fading across its
             own length, and the drift must not make it flicker. */
          veil: veil(x + tw / 2, y),
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
        var dx = reduced ? 0 : Math.sin(t * w.speed * SPEED + w.phase) * w.amp;
        var dy = reduced ? 0 : Math.cos(t * w.speed * SPEED * 0.7 + w.phase) * w.amp * 0.4;
        var x = w.x + dx, y = w.y + dy;
        var md = Math.hypot(mouse.x - x, mouse.y - y);
        var near = Math.max(0, 1 - md / 150);
        for (var g2 of rings) {
          var rd = Math.abs(Math.hypot(g2.x - x, g2.y - y) - g2.r);
          if (rd < 46) w.boost = Math.max(w.boost, g2.a * (1 - rd / 46));
        }
        w.boost *= 0.94;
        var k = Math.max(near, w.boost);
        var base = Math.min(0.6, (w.accent ? 0.34 : 0.10) * REST);
        var alpha = (base + (0.9 - base) * k * k) * w.veil;
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
