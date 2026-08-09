"use client";

import { useTranslations } from "next-intl";
import { useCallback, useRef, useState, useTransition } from "react";
import { useToast } from "@/components/ui/toast";
import { INVALID_INPUT } from "@/lib/validation-keys";
import type { ActionResult, FieldErrors } from "@/server/action-result";

/**
 * Running a server action, and saying what happened (W1.5).
 *
 * **The rule this exists to make keepable:** *every* server-action result
 * produces feedback. Before this, each call site decided for itself — most
 * caught failures into a local `useState<string | null>` and rendered it
 * somewhere near the button, several ignored the result entirely, and none of
 * them said anything at all on success. A form that silently succeeds and a
 * form that silently fails look identical, which is why the audit's tester
 * submitted the same campaign twice.
 *
 * `tests/lib/action-feedback.test.ts` enumerates every component that imports a
 * server action and requires it to come through here, so the next one cannot
 * quietly go back to failing into a variable nobody renders.
 *
 * ```tsx
 * const { run, pending, fieldErrors, formRef, invalid } = useAction();
 *
 * <form ref={formRef} action={(data) => run(() => createThing(data), {
 *   success: t("created"),
 *   onSuccess: () => formRef.current?.reset(),
 * })}>
 *   <Input name="title" {...invalid("title")} />
 *   <FieldError message={fieldErrors.title} />
 * ```
 *
 * **Where focus goes.** On a validation failure the toast announces the
 * summary and focus moves to the **first invalid control** — not to the toast,
 * which would leave the reader somewhere they cannot type. That is WCAG 3.3.1
 * and 3.3.3 (error identification and suggestion), and it is the difference
 * between a form that tells you something is wrong and one that takes you to it.
 */

export type RunOptions<T = unknown> = {
  /**
   * What to say when it works. Omit for an action whose effect is already
   * visible — a toggle that flips, a row that vanishes — where a toast would be
   * narration rather than news.
   */
  success?: string;
  /**
   * Runs after a success, with the result — so a form that creates something
   * can navigate to the id the server just minted without re-reading it.
   */
  onSuccess?: (result: ({ ok: true } & T) | undefined) => void;
  /** Extra handling for a failure. The toast fires either way. */
  onError?: (result: { error: string; code?: string }) => void;
  /**
   * Replaces the failure text with product copy.
   *
   * For the one case where the server's own sentence is not the best thing to
   * show: `src/compliance/gate.ts` refuses with a machine-readable reason, and
   * "no registered permission for this person" is worth translating properly
   * because it is a refusal the operator has to act on. Returning `undefined`
   * keeps the server's message, which stays the default everywhere else — a
   * hook that let every caller rewrite every error would end up with thirty
   * different ways to say the same failure.
   */
  message?: (result: { error: string; code?: string }) => string | undefined;
};

export type UseAction = {
  run: <T>(action: () => Promise<ActionResult<T>>, options?: RunOptions<T>) => void;
  pending: boolean;
  fieldErrors: FieldErrors;
  /** Put this on the `<form>` so a failure can find the control to focus. */
  formRef: React.RefObject<HTMLFormElement | null>;
  /** Spread onto an input: marks it invalid for assistive technology. */
  invalid: (field: string) => { "aria-invalid"?: true; "aria-errormessage"?: string };
  /** Clears any field errors — for a control that has just been corrected. */
  clearField: (field: string) => void;
};

/** The id a field's message is rendered under. Shared with `FieldError`. */
export function fieldErrorId(field: string): string {
  return `field-error-${field}`;
}

export function useAction(): UseAction {
  const { toast } = useToast();
  const t = useTranslations("validation");
  const [pending, startTransition] = useTransition();
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const formRef = useRef<HTMLFormElement>(null);

  const run = useCallback(
    <T>(action: () => Promise<ActionResult<T>>, options: RunOptions<T> = {}) => {
      setFieldErrors({});

      startTransition(async () => {
        let result: ActionResult<T>;

        try {
          result = await action();
        } catch (error) {
          // A thrown action — a network drop, a serialization failure, a bug —
          // used to leave the form spinning and then simply stop. Whatever
          // else is true, the reader has to be told the attempt is over.
          toast("error", error instanceof Error ? error.message : "Something went wrong.");
          return;
        }

        if (result.ok) {
          if (options.success) toast("success", options.success);
          options.onSuccess?.(result);
          return;
        }

        // The server names *which* field and *what* is wrong with it; the
        // sentence saying so is written here, because this is the first point in
        // the round trip that knows what language the reader is in. A schema
        // runs long before anybody knows that, and Zod's own defaults — and its
        // `tr` locale — are a compiler's prose rather than a product's.
        const fieldMessages = result.fieldErrors
          ? Object.fromEntries(
              Object.entries(result.fieldErrors).map(([field, key]) => [field, t(key)]),
            )
          : undefined;

        const summary =
          options.message?.(result) ??
          (result.code === INVALID_INPUT && fieldMessages && Object.keys(fieldMessages).length > 0
            ? t("summary")
            : result.error);

        toast("error", summary);
        options.onError?.(result);

        if (!fieldMessages) return;
        setFieldErrors(fieldMessages);

        // Focus the first control the server named. Reading order rather than
        // object-key order: the fields the reader has to fix are the ones on
        // the screen, and "first" has to mean first as they see it.
        const form = formRef.current;
        if (!form) return;

        const named = Object.keys(fieldMessages);
        const controls = Array.from(
          form.querySelectorAll<HTMLElement>("input, select, textarea, [contenteditable]"),
        );
        const target = controls.find((control) =>
          named.includes(control.getAttribute("name") ?? ""),
        );

        target?.focus();
      });
    },
    [toast, t],
  );

  const invalid = useCallback(
    (field: string) =>
      fieldErrors[field]
        ? ({ "aria-invalid": true, "aria-errormessage": fieldErrorId(field) } as const)
        : {},
    [fieldErrors],
  );

  const clearField = useCallback((field: string) => {
    setFieldErrors((current) => {
      if (current[field] === undefined) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  return { run, pending, fieldErrors, formRef, invalid, clearField };
}
