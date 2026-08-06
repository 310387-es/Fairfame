"use client";

import { Search, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/components/ui/use-action";
import { MAX_RECIPIENTS_PER_SEND } from "@/collect/input";
import { findRecipientsAction, type PickerContact } from "@/server/campaigns";

/**
 * Choosing who to ask (W2.2).
 *
 * Replaces a bare 200-address textarea, and the replacement is not only nicer —
 * it is the only shape a WhatsApp or SMS send can take. Consent is recorded
 * against a *person*, so `checkSendAllowed` is keyed on a contact id: a send
 * that began with a pasted number would have to invent a contact before it
 * could ask whether it was allowed to message them.
 *
 * So the two halves are not two ways of doing the same thing:
 *
 *   - **Pick from contacts** — the only route for WhatsApp and SMS, and
 *     available for email too.
 *   - **Paste or import** — email only, because an address may belong to
 *     somebody we have never heard of and the contact is created as part of the
 *     send. A CSV is parsed properly (`src/collect/csv.ts`), which is what a
 *     real export out of a POS actually looks like.
 *
 * The search is deliberately **not** debounced-on-keystroke. A picker that
 * queries as you type is a picker that runs a scoped database read on every
 * letter; pressing Enter or the button is one read, and the field is small
 * enough that nobody is hunting through pages.
 */
export function RecipientPicker({
  campaignId,
  channel,
  disabled,
}: {
  campaignId: string;
  channel: "email" | "whatsapp" | "sms";
  disabled: boolean;
}) {
  const t = useTranslations("requests");
  const searchId = useId();
  const pasteId = useId();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickerContact[] | null>(null);
  const [chosen, setChosen] = useState<PickerContact[]>([]);
  const { run, pending: searching } = useAction();

  // Email is the only channel that can address somebody we do not already hold.
  const canPaste = channel === "email";

  /**
   * Through `useAction`, even though this is a read.
   *
   * The exemptions in `tests/lib/action-feedback.test.ts` are for components
   * that query *as you type* or *on a timer*, where a toast per keystroke would
   * be the opposite of feedback. This one searches only when somebody presses
   * Enter or the button — an act with an expected result — so a failure has to
   * be reported, and reported the same way every other failure in the product
   * is. Catching it into local state would be a second, quieter error channel.
   */
  const search = () => {
    void run(() => findRecipientsAction({ query, channel }), {
      onSuccess: (result) => setResults(result?.contacts ?? []),
    });
  };

  const add = (contact: PickerContact) => {
    setChosen((current) =>
      current.some((entry) => entry.id === contact.id) || current.length >= MAX_RECIPIENTS_PER_SEND
        ? current
        : [...current, contact],
    );
  };

  return (
    <div className="flex flex-col gap-3">
      {/* What the form actually posts. The chips are the interface; this is the
          value, so a send cannot disagree with what is on screen. */}
      <input type="hidden" name="contactIds" value={chosen.map((entry) => entry.id).join(",")} />

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${searchId}-${campaignId}`}>{t("pickerLabel")}</Label>
        <div className="flex gap-2">
          <Input
            id={`${searchId}-${campaignId}`}
            value={query}
            disabled={disabled}
            placeholder={t("pickerPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter searches; it must not submit the send form, which is the
              // one keystroke in this component that cannot be taken back.
              if (event.key === "Enter") {
                event.preventDefault();
                search();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || searching}
            onClick={search}
          >
            <Search className="size-4" aria-hidden />
            {t("pickerSearch")}
          </Button>
        </div>
      </div>

      {chosen.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {chosen.map((contact) => (
            <li key={contact.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  setChosen((current) => current.filter((entry) => entry.id !== contact.id))
                }
                className="inline-flex items-center gap-1 rounded-full border border-primary bg-primary px-2.5 py-1 text-[12px] font-medium text-primary-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {contact.name ?? contact.address ?? "—"}
                <X className="size-3" aria-hidden />
                <span className="sr-only">{t("pickerRemove")}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {results !== null ? (
        results.length === 0 ? (
          <p className="text-copy text-muted-foreground">{t("pickerNoResults")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {results.map((contact) => {
              const already = chosen.some((entry) => entry.id === contact.id);

              return (
                <li key={contact.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 text-body">
                    {contact.name ?? t("pickerUnnamed")}
                    {contact.address ? (
                      <span className="ml-2 text-copy text-faint">{contact.address}</span>
                    ) : null}
                  </span>

                  {already ? (
                    <Badge variant="secondary">{t("pickerAdded")}</Badge>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => add(contact)}
                    >
                      {t("pickerAdd")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {canPaste ? (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <Label htmlFor={`${pasteId}-${campaignId}`}>{t("recipients")}</Label>
          <Textarea
            id={`${pasteId}-${campaignId}`}
            name="recipients"
            disabled={disabled}
            placeholder={t("recipientsPlaceholder")}
          />

          {/*
            The file is read in the browser and dropped into the textarea rather
            than uploaded. The parser is the same either way, and the owner gets
            to *see* what was read before sending — which is the difference
            between "212 recipients" and a list they can check.
          */}
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" disabled={disabled}>
              <label className="cursor-pointer">
                <Upload className="size-4" aria-hidden />
                {t("importCsv")}
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  className="sr-only"
                  disabled={disabled}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;

                    const text = await file.text();
                    const field = document.getElementById(
                      `${pasteId}-${campaignId}`,
                    ) as HTMLTextAreaElement | null;

                    if (field) {
                      field.value = field.value ? `${field.value}\n${text}` : text;
                    }
                    // Cleared so choosing the same file twice fires again.
                    event.target.value = "";
                  }}
                />
              </label>
            </Button>
            <p className="text-copy text-muted-foreground">
              {t("recipientsHint", { max: MAX_RECIPIENTS_PER_SEND })}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-copy text-muted-foreground">{t("pickerContactsOnly")}</p>
      )}
    </div>
  );
}
