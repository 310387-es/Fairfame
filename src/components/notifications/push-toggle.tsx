"use client";

import { BellRing, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import { subscribeToPushAction, unsubscribeFromPushAction } from "@/server/push";

/**
 * "Notify me on this device" (W5-9).
 *
 * Everything here is about a browser API with three separate failure modes, and
 * the component's job is to tell them apart rather than showing one dead
 * button:
 *
 *   - **Unsupported.** iOS before 16.4, or any browser without a push service.
 *     Saying so is better than a control that never works.
 *   - **Denied.** The permission was refused *at some point*, and the browser
 *     will not ask again — pressing the button does nothing at all, silently,
 *     for ever. The only fix is in the browser's own settings, so that is what
 *     the copy says.
 *   - **Not yet asked.** The ordinary case, and the only one where a button is
 *     worth rendering.
 *
 * The permission prompt fires **on the press and never on load**. A page that
 * asks for notification permission the moment it renders is the pattern every
 * browser now penalises and every user refuses, and a refusal is permanent.
 */
export function PushToggle({ publicKey }: { publicKey: string | null }) {
  const t = useTranslations("settings.notifications.push");
  const { run, pending } = useAction();
  const [state, setState] = useState<"loading" | "unsupported" | "denied" | "off" | "on">(
    "loading",
  );

  useEffect(() => {
    let cancelled = false;

    /*
      Every branch resolves asynchronously, including the two that are really
      synchronous reads.

      Not a dodge around the `set-state-in-effect` rule — it is the honest
      shape. `navigator` does not exist during the server render, so the
      component must render the same thing on both sides and then learn what
      the browser can do; setting state synchronously here would mean the first
      client render disagreed with the server's.
    */
    void (async () => {
      const supported =
        "serviceWorker" in navigator && "PushManager" in window && publicKey !== null;
      if (!supported) return "unsupported" as const;

      // Denied is permanent from our side: the browser will not ask again, and
      // the button would do nothing at all, silently, for ever.
      if (Notification.permission === "denied") return "denied" as const;

      /*
        `getRegistration`, never `ready`.

        `serviceWorker.ready` resolves only once a worker is *active*, so on a
        browser that has never registered one it never resolves at all — no
        rejection, no timeout, just a promise that hangs. The component sat on
        its loading state and rendered nothing, for ever, on exactly the fresh
        browser this feature exists for. It took a screenshot to notice, because
        "nothing rendered" and "still loading" look identical.

        `getRegistration` resolves immediately with `undefined` when there is
        none, which is the answer: not subscribed.
      */
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration) return "off" as const;
        return (await registration.pushManager.getSubscription())
          ? ("on" as const)
          : ("off" as const);
      } catch {
        return "off" as const;
      }
    })().then((next) => {
      if (!cancelled) setState(next);
    });

    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  if (state === "loading") return null;

  if (state === "unsupported" || state === "denied") {
    return (
      <p className="text-copy text-muted-foreground">
        {t(state === "denied" ? "denied" : "unsupported")}
      </p>
    );
  }

  const enable = () =>
    run(async () => {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        // Required by every browser, and the reason there is no such thing as a
        // silent push here: a push that shows nothing is a push that can be
        // used for tracking, so the platforms simply refuse it.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey!),
      });

      const result = await subscribeToPushAction(
        subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } },
      );
      if (result.ok) setState("on");
      return result;
    });

  const disable = () =>
    run(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (!subscription) {
        setState("off");
        return { ok: true as const };
      }

      // The browser first, then us. The other order can leave a live endpoint
      // we have forgotten about, which then fails for ever with no row to prune.
      await subscription.unsubscribe();
      const result = await unsubscribeFromPushAction({ endpoint: subscription.endpoint });
      if (result.ok) setState("off");
      return result;
    });

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Button
        type="button"
        size="sm"
        variant={state === "on" ? "ghost" : "outline"}
        disabled={pending}
        onClick={state === "on" ? disable : enable}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <BellRing className="size-4" aria-hidden />
        )}
        {t(state === "on" ? "disable" : "enable")}
      </Button>

      <p className="text-copy text-muted-foreground">{t(state === "on" ? "onBody" : "offBody")}</p>
    </div>
  );
}

/**
 * The VAPID key, in the shape `pushManager.subscribe` demands.
 *
 * It is base64url on the wire and the API wants raw bytes. Not a helper worth
 * sharing: this is the only caller, and the conversion is four lines that would
 * be harder to find in another file than to read here.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));

  // Allocated explicitly rather than through `Uint8Array.from`, whose return
  // type is `Uint8Array<ArrayBufferLike>` — which `applicationServerKey` will
  // not accept, because a `SharedArrayBuffer` cannot be transferred to the push
  // service. The buffer has to be a plain one and the type has to say so.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
