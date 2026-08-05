"use client";

import { Download, MailX, Pencil, Trash2, Undo2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/components/ui/use-action";
import type { ActionResult } from "@/server/action-result";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  eraseContactAction,
  exportContactAction,
  renameContactAction,
  setContactSubscriptionAction,
} from "@/server/contacts";

/**
 * The controls on a contact profile (P4-T1).
 *
 * Four acts of quite different weight, which is why they are not four
 * identical buttons in a row. Renaming is an edit. Opting somebody out is
 * honouring a request and needs no ceremony at all. **Clearing** an opt-out and
 * **erasing** a person are the two that get in the way of themselves — the
 * first because a business un-blocking someone on their behalf is the shape of
 * a complaint, the second because it is irreversible.
 *
 * The KVKK export downloads in the browser rather than being written anywhere:
 * it is a copy of somebody's personal data, and the fewer places it comes to
 * rest the better.
 */
export function ContactAdmin({
  contactId,
  name,
  unsubscribed,
  canManage,
}: {
  contactId: string;
  name: string | null;
  unsubscribed: boolean;
  /** Admin. Clearing an opt-out, exporting and erasing are all admin-only. */
  canManage: boolean;
}) {
  const t = useTranslations("contacts");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(name ?? "");
  const [confirmErase, setConfirmErase] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { run: runAction, pending } = useAction();

  const run = <T,>(fn: () => Promise<ActionResult<T>>, after?: (result: T | undefined) => void) => {
    setNotice(null);
    runAction(fn, {
      // No blanket success string: each caller below says what it did — a KVKK
      // export and an erasure are not both "Saved" (W1.5).
      onSuccess: (result) => after?.(result as T | undefined),
      message: (result) => result.error || t("actionFailed"),
    });
  };

  const download = () => {
    run(
      () => exportContactAction({ contactId }),
      (result) => {
        // `URL.revokeObjectURL` immediately after the click: the anchor has
        // already handed the blob to the download, and leaving the URL alive
        // keeps the personal data addressable for the life of the tab.
        const blob = new Blob([result?.json ?? "{}"], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `contact-${contactId}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setNotice(t("exportDone"));
      },
    );
  };

  return (
    <div className="flex flex-col gap-3 pb-(--card-py)">
      {editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid min-w-48 flex-1 gap-1.5">
            <Label htmlFor="contact-name">{t("nameLabel")}</Label>
            <Input
              id="contact-name"
              value={draftName}
              maxLength={120}
              autoFocus
              onChange={(event) => setDraftName(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 pb-1">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(
                  () => renameContactAction({ contactId, name: draftName }),
                  () => setEditing(false),
                )
              }
            >
              {t("save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setDraftName(name ?? "");
                setEditing(false);
              }}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={pending}>
            <Pencil aria-hidden />
            {t("rename")}
          </Button>

          {unsubscribed ? (
            canManage ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() =>
                  run(() => setContactSubscriptionAction({ contactId, subscribed: true }))
                }
              >
                <Undo2 aria-hidden />
                {t("clearOptOut")}
              </Button>
            ) : null
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() =>
                run(() => setContactSubscriptionAction({ contactId, subscribed: false }))
              }
            >
              <MailX aria-hidden />
              {t("optOut")}
            </Button>
          )}

          {canManage ? (
            <>
              <Button size="sm" variant="outline" onClick={download} disabled={pending}>
                <Download aria-hidden />
                {t("exportData")}
              </Button>

              <Button
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={pending}
                onClick={() => setConfirmErase(true)}
              >
                <Trash2 aria-hidden />
                {t("erase")}
              </Button>
            </>
          ) : null}
        </div>
      )}

      {/* Erasure asks a second time, in its own block, and says what it does. */}
      {confirmErase ? (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-state-negative-bg px-3 py-3">
          <p className="text-copy text-state-negative-text">{t("eraseConfirm")}</p>
          <p className="text-meta text-state-negative-text">{t("eraseExplains")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={pending}
              onClick={() =>
                run(
                  () => eraseContactAction({ contactId }),
                  () => router.push("/contacts"),
                )
              }
            >
              {t("eraseSubmit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirmErase(false)}
            >
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p role="status" className="text-copy text-ink-400">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
