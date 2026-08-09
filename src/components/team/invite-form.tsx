"use client";

import { Mail, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldError } from "@/components/ui/field-error";
import { useAction } from "@/components/ui/use-action";
import { cancelInvitationAction, inviteMemberAction } from "@/server/invitations";

/**
 * Inviting a teammate, and seeing who has not answered yet (W1.9).
 *
 * **The product could not make a second user.** `/team` set location scope for
 * members who could only be created from a database console, and its own copy
 * said invitations were a later phase — which meant the assignee dropdown on 86
 * review cards was permanently "Unassigned", and the whole of P2's team
 * workflow was unreachable by an actual team.
 *
 * The pending list is not decoration: an invitation is a thing that has been
 * *sent* and may never be answered, and without somewhere to see it the only
 * way to know whether you had already invited somebody was to invite them
 * again.
 */

export type PendingInvitation = {
  id: string;
  email: string;
  role: string;
  /** ISO string: this crosses the server/client boundary. */
  expiresAt: string;
};

export function InviteForm({
  pending: invitations,
  roleLabels,
  atLimit,
}: {
  pending: PendingInvitation[];
  /** Translated in the reader's locale, not the invitee's. */
  roleLabels: Record<string, string>;
  /** The seat limit is spent — say so rather than offering a form that fails. */
  atLimit: string | null;
}) {
  const t = useTranslations("team");
  const tf = useTranslations("feedback");
  const format = useFormatter();
  const { run, pending, fieldErrors, formRef, invalid } = useAction();

  return (
    <div className="flex flex-col gap-4">
      {atLimit ? (
        <p className="text-body text-pretty text-ink-400">{atLimit}</p>
      ) : (
        <form
          ref={formRef}
          className="flex flex-wrap items-end gap-3"
          action={(formData) =>
            run(
              () =>
                inviteMemberAction({
                  email: String(formData.get("email") ?? ""),
                  role: String(formData.get("role") ?? "member"),
                }),
              { success: tf("sent"), onSuccess: () => formRef.current?.reset() },
            )
          }
        >
          <div className="min-w-56 flex-1 space-y-2">
            <Label htmlFor="invite-email">{t("inviteEmail")}</Label>
            <Input
              id="invite-email"
              name="email"
              type="email"
              aria-required
              placeholder={t("inviteEmailPlaceholder")}
              {...invalid("email")}
            />
            <FieldError name="email" message={fieldErrors.email} />
          </div>

          <div className="w-40 space-y-2">
            <Label htmlFor="invite-role">{t("inviteRole")}</Label>
            {/* Owner is absent on purpose: an organization has one, and handing
                it over is a different act from adding somebody. */}
            <Select name="role" defaultValue="member">
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="admin">{roleLabels.admin}</SelectItem>
                <SelectItem value="member">{roleLabels.member}</SelectItem>
                <SelectItem value="client">{roleLabels.client}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <Button type="submit" disabled={pending}>
            <Mail className="size-4" aria-hidden />
            {pending ? t("inviting") : t("invite")}
          </Button>
        </form>
      )}

      {invitations.length > 0 ? (
        <ul className="flex flex-col gap-2 border-t border-line-soft pt-3">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-wrap items-center gap-2 text-copy">
              <span className="min-w-0 flex-1 truncate">{invitation.email}</span>
              <span className="text-ink-400">{roleLabels[invitation.role] ?? invitation.role}</span>
              <span className="text-meta text-faint">
                {t("inviteExpires", {
                  date: format.dateTime(new Date(invitation.expiresAt), "short"),
                })}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  run(() => cancelInvitationAction({ invitationId: invitation.id }), {
                    success: tf("removed"),
                  })
                }
              >
                <X className="size-3.5" aria-hidden />
                {t("inviteCancel")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
