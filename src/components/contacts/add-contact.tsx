"use client";

import { Loader2, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/components/ui/use-action";
import { addContactAction } from "@/server/contacts";

/**
 * One person, by hand (A22-C2).
 *
 * `/contacts` could only be filled from a CSV, so an owner who wanted to add
 * the regular sitting in front of them had to build a file first. Three fields
 * and a button is the whole feature — what took the thinking is that it must
 * not become a second definition of what adding a contact means. The action is
 * a one-row import, so the matching rule and, more importantly, the **"this
 * grants no permission"** rule are the ones `importContacts` already enforces.
 *
 * That sentence sits above the button rather than in a toast afterwards, for
 * the reason `ImportContacts` states: a business that adds somebody and then
 * finds every message to them refused has learned the rule at the worst
 * possible moment.
 *
 * Either an address or a number, not both required — a till captures a phone
 * and a web form captures an email, and `contacts` has accepted either since
 * P1b-T1. The refusal for neither comes from the server, so it is one rule.
 */
export function AddContact() {
  const t = useTranslations("contacts.add");
  const tf = useTranslations("feedback");
  const { run, pending, fieldErrors, formRef } = useAction();
  const [added, setAdded] = useState<string | null>(null);

  return (
    <form
      ref={formRef}
      className="flex flex-col gap-3"
      action={(formData) => {
        setAdded(null);
        run(
          () =>
            addContactAction({
              name: String(formData.get("name") ?? ""),
              email: String(formData.get("email") ?? ""),
              phone: String(formData.get("phone") ?? ""),
            }),
          {
            success: tf("created"),
            onSuccess: (result) => {
              formRef.current?.reset();
              // "Added" and "we already had them" are different answers, and a
              // business adding somebody twice deserves the second one.
              if (result) setAdded(result.result.created > 0 ? t("added") : t("merged"));
            },
          },
        );
      }}
    >
      <p className="text-body text-pretty text-ink-400">{t("body")}</p>

      {/* Before the fields, never after the result. */}
      <p className="text-copy text-muted-foreground">{t("noPermission")}</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contact-name">{t("name")}</Label>
          <Input id="contact-name" name="name" maxLength={120} disabled={pending} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contact-email">{t("email")}</Label>
          <Input
            id="contact-email"
            name="email"
            type="email"
            maxLength={320}
            disabled={pending}
            aria-invalid={fieldErrors.email ? true : undefined}
          />
          <FieldError name="email" message={fieldErrors.email} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="contact-phone">{t("phone")}</Label>
          <Input id="contact-phone" name="phone" type="tel" maxLength={40} disabled={pending} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <UserPlus className="size-4" aria-hidden />
          )}
          {t("submit")}
        </Button>

        {added ? <p className="text-copy text-muted-foreground">{added}</p> : null}
      </div>
    </form>
  );
}
