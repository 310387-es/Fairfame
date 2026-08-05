import { cacheableResponse, SCRIPT_CACHE } from "@/widgets/http";
import { SIZE_MESSAGE_TYPE } from "@/widgets/config";

/**
 * The embed loader: `GET /embed/widget.js`.
 *
 * The one file a customer pastes into their site, so it is held to a standard
 * the rest of the app is not — it runs in *their* page, next to their
 * analytics, their consent banner and their checkout.
 *
 * What it does, and nothing else: find its own `<script>` tags, mount an iframe
 * pointing at `/embed/w/{key}`, and keep that iframe's height in step with its
 * content. It draws no markup, reads no cookies, sets no globals, sends no
 * telemetry, and touches nothing outside the element it inserts.
 *
 * **Why an iframe and not shadow DOM.** `docs/19` asks for an embed script plus
 * an iframe fallback. Rendering in the page and rendering in a frame would be
 * two implementations of the same widget, and the fallback would be the one
 * that quietly rots. An iframe collapses them into one: the frame document is
 * the renderer, the script is a mount point, and a customer who prefers a bare
 * `<iframe>` tag gets byte-identical output. It also gives the widget real
 * isolation — the host page's CSS cannot reach in, ours cannot leak out, and a
 * page with a strict `script-src` can still frame us.
 *
 * Served from a route rather than `public/` so it shares one cache policy with
 * the other public endpoints and can be regenerated rather than hand-edited.
 */

/**
 * ES5, no build step, no dependency.
 *
 * Deliberately old-fashioned JavaScript: this executes in whatever browser the
 * customer's visitor happens to have, and a syntax error from a language
 * feature we assumed is not a degraded widget — it is a parse failure in the
 * middle of somebody else's page.
 */
const LOADER = `(function () {
  "use strict";

  var MESSAGE_TYPE = ${JSON.stringify(SIZE_MESSAGE_TYPE)};
  var MOUNTED = "reviraMounted";

  /* Where this script came from is where the widget lives. The customer pasted
     one absolute URL; asking them to keep a second one in step would be a
     support ticket waiting to happen. */
  function originOf(script) {
    var override = script.getAttribute("data-revira-base");
    if (override) return override.replace(/\\/+$/, "");
    var link = document.createElement("a");
    link.href = script.src;
    return link.protocol + "//" + link.host;
  }

  function mount(script) {
    if (script.getAttribute(MOUNTED) === "1") return;
    var key = script.getAttribute("data-revira-widget");
    if (!key || !/^[a-z0-9]{1,64}$/.test(key)) return;
    script.setAttribute(MOUNTED, "1");

    var frame = document.createElement("iframe");
    frame.src = originOf(script) + "/embed/w/" + key;
    /* A frame with no accessible name is announced as "frame" and nothing else.
       The host page may override it for a more specific one. */
    frame.title = script.getAttribute("data-revira-title") || "Customer reviews";
    frame.loading = "lazy";
    frame.setAttribute("scrolling", "no");
    /* No same-origin, so the frame cannot reach this page's storage or DOM even
       though it is ours. It needs scripts only for the height message, and
       popups-to-escape-sandbox so a review link opens as a normal tab. */
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-popups allow-popups-to-escape-sandbox"
    );
    /* Full-bleed until the widget says otherwise. A review wall wants the whole
       slot; a rating badge sends back a width and this becomes inline-block. */
    frame.style.cssText =
      "width:100%;max-width:100%;border:0;display:block;overflow:hidden;color-scheme:normal";
    /* A first guess, replaced by the frame's own measurement within a tick.
       Starting at zero would make the page jump; starting tall would leave a
       gap on a one-review widget. The builder writes a small one into the
       snippet for a badge, where 420 would be a visible flash of nothing. */
    frame.style.height = (script.getAttribute("data-revira-height") || "420") + "px";

    if (script.parentNode) script.parentNode.insertBefore(frame, script.nextSibling);

    /* Identify the sender by its window, not by anything in the message. A
       string in the payload could be spoofed by any other frame on the page;
       \`event.source\` cannot. */
    window.addEventListener("message", function (event) {
      if (event.source !== frame.contentWindow) return;
      var data = event.data;
      if (!data || data.type !== MESSAGE_TYPE) return;
      var height = parseInt(data.height, 10);
      if (height > 0 && height < 20000) frame.style.height = height + "px";

      /* Width arrives only from a widget whose root is sized by its own content
         — the rating badge. Everything else leaves the frame full-bleed, which
         is why this is an \`if\` and not an \`else\`: an older frame, or a newer
         one rendering a review wall, simply never sends the field. */
      var width = parseInt(data.width, 10);
      if (width > 0 && width < 5000) {
        frame.style.width = width + "px";
        /* So a badge sits beside whatever the customer put it next to instead
           of pushing it onto its own line. */
        frame.style.display = "inline-block";
        frame.style.verticalAlign = "middle";
      }
    });
  }

  function mountAll() {
    var scripts = document.querySelectorAll("script[data-revira-widget]");
    for (var i = 0; i < scripts.length; i++) mount(scripts[i]);
  }

  /* \`currentScript\` is null when the tag carries async or defer, so the sweep
     is the reliable path and currentScript is only the fast one. */
  if (document.currentScript) mount(document.currentScript);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountAll);
  } else {
    mountAll();
  }
})();
`;

export async function GET(request: Request): Promise<Response> {
  return cacheableResponse(request, LOADER, "application/javascript; charset=utf-8", SCRIPT_CACHE);
}
