/**
 * The service worker (W5-9).
 *
 * Deliberately **tiny, and it caches nothing.**
 *
 * A service worker's usual job is offline caching, and this product must not do
 * it: every screen is a live figure about somebody's business, and a cached
 * dashboard showing yesterday's rating with no indication that it is stale is
 * worse than a page that says it cannot reach the network. The browser already
 * says that, in words the user's operating system chose.
 *
 * So this exists for exactly one reason — a `push` event has nowhere else to be
 * delivered. Without a registered worker there is no Web Push at all.
 *
 * `notificationclick` opens the review rather than the dashboard, because the
 * notification was about one thing and the whole point of tapping it is to deal
 * with that thing. It focuses an open tab if there is one: an owner with the
 * product already open on their phone should not get a second copy of it.
 */

self.addEventListener("install", () => {
  // Take over immediately. The alternative is a worker that only starts
  // handling pushes after every tab has been closed once, which for a tool
  // people leave open all day means "after the weekend".
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    // A push we cannot parse is not worth a blank notification. Silence is the
    // honest failure — the in-app feed still has the row.
    return;
  }

  const { title, body, url, tag } = payload;
  if (!title) return;

  event.waitUntil(
    self.registration.showNotification(title, {
      body: body ?? "",
      // The seal, as PNG. This used to point at `/icon.svg`, which no longer
      // exists — the icons moved to `public/` when the brand landed. A raster
      // is also the safer choice here: SVG support for notification icons is
      // uneven across the browsers that implement push at all, and the failure
      // is a notification with a hole where the mark should be.
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // The dedupe key, so a retried delivery replaces rather than stacks. It
      // is a string the platform compares to itself, not a name anybody reads,
      // which is why the rename left it alone.
      tag: tag ?? "revira",
      data: { url: url ?? "/dashboard" },
      // Never `requireInteraction`: a notification that will not go away until
      // it is tapped is the behaviour that gets an app's permission revoked.
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url ?? "/dashboard";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          // Focus what is already open, then take it where the notification
          // was about. Two copies of the same app is the thing to avoid.
          void client.navigate(target);
          return client.focus();
        }
      }

      return self.clients.openWindow(target);
    }),
  );
});
