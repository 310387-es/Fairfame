"use client";

import { AlertTriangle, Check, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Toast } from "radix-ui";
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * The product's one piece of transient feedback (W1.5).
 *
 * **Why it exists.** Every form in the product used to fail into a local
 * `useState<string | null>` rendered near the submit button — when it rendered
 * one at all. A campaign that failed validation, a widget that saved, a
 * location that could not be added: all of them either said nothing or said it
 * somewhere the reader had already scrolled past. The audit's tester typed a
 * campaign name twice because nothing acknowledged the first attempt.
 *
 * So success and failure both land here, in the same place, every time. That
 * consistency is the feature: a reader who has seen one toast knows where to
 * look for the next.
 *
 * **Design.** `docs/15` §4: a floating panel is `--elevation-md`, corners are
 * 14px, motion is 180ms on the system curve with no bounce. §1 rule 3 —
 * *never say it in colour alone* — is why every toast carries a glyph and a
 * word, not a green or red bar. Errors persist ~3× longer than confirmations:
 * "saved" is a glance, "that did not work" is something you have to read.
 *
 * **Accessibility.** Radix `Toast` puts the viewport in an `aria-live` region,
 * so a message is announced without stealing focus — which matters because the
 * *field* is where focus belongs after a validation failure (see `useAction`).
 * `role="alert"` on failures announces them assertively; a confirmation is
 * polite and must not interrupt someone mid-sentence.
 */

export type ToastTone = "success" | "error";

type ToastMessage = {
  id: number;
  tone: ToastTone;
  text: string;
};

type ToastApi = {
  /** Show a message. Returns nothing — a toast is fire-and-forget by design. */
  toast: (tone: ToastTone, text: string) => void;
};

const ToastContext = createContext<ToastApi | null>(null);

/** A glance. */
const SUCCESS_MS = 4_000;
/** Long enough to read a sentence, and to reach for the close button. */
const ERROR_MS = 12_000;

/**
 * How many messages may stack.
 *
 * A bulk action can produce a burst, and twelve stacked toasts is a wall rather
 * than feedback. The oldest go first, because the newest is the one the reader
 * just caused.
 */
const MAX_VISIBLE = 3;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("shell");
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const toast = useCallback((tone: ToastTone, text: string) => {
    setMessages((current) => {
      // `Date.now()` would collide when two results land in the same tick, and
      // a duplicate React key on a live region is a rendering bug in the one
      // place nobody is looking.
      const id = (current[current.length - 1]?.id ?? 0) + 1;
      return [...current, { id, tone, text }].slice(-MAX_VISIBLE);
    });
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  const dismiss = useCallback((id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={api}>
      <Toast.Provider swipeDirection="right">
        {children}

        {messages.map((message) => (
          <Toast.Root
            key={message.id}
            duration={message.tone === "error" ? ERROR_MS : SUCCESS_MS}
            onOpenChange={(open) => {
              if (!open) dismiss(message.id);
            }}
            // Assertive for a failure, polite for a confirmation: interrupting
            // somebody to tell them a thing worked is not help.
            type={message.tone === "error" ? "foreground" : "background"}
            className={cn(
              "flex items-start gap-2.5 rounded-lg border bg-card p-3.5 shadow-md",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-bottom-2",
              "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
              "data-[swipe=end]:animate-out data-[swipe=end]:fade-out-0",
              message.tone === "error" ? "border-state-negative-text/25" : "border-line",
            )}
          >
            {message.tone === "error" ? (
              <AlertTriangle
                className="mt-px size-4 shrink-0 text-state-negative-text"
                aria-hidden
              />
            ) : (
              <Check className="mt-px size-4 shrink-0 text-state-positive-text" aria-hidden />
            )}

            <Toast.Description className="min-w-0 flex-1 text-body text-pretty text-foreground">
              {message.text}
            </Toast.Description>

            <Toast.Close
              aria-label={t("dismiss")}
              className="-m-1 rounded-sm p-1 text-ink-400 transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <X className="size-3.5" aria-hidden />
            </Toast.Close>
          </Toast.Root>
        ))}

        {/* Bottom-right on a desktop, full width along the bottom of a phone —
            where a thumb is, and clear of the top bar's controls. */}
        <Toast.Viewport className="fixed right-0 bottom-0 z-100 flex w-full max-w-[min(26rem,calc(100vw-2rem))] list-none flex-col gap-2 p-4 outline-none" />
      </Toast.Provider>
    </ToastContext.Provider>
  );
}

/**
 * The raw toast API.
 *
 * Most callers want `useAction` instead, which reports every server-action
 * result through this without each form having to remember to. Reach for this
 * directly only where there is no action to report — a copy-to-clipboard, say.
 */
export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used inside <ToastProvider>.");
  }
  return context;
}
