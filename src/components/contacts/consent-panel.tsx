import { getFormatter, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { isRegisteredVia } from "@/compliance/iys-gateway";
import type { ContactConsent } from "@/contacts/consent";

/**
 * What permissions this person has given (P4-T1).
 *
 * **A record, not a verdict.** Whether a message may actually be sent is
 * decided by `checkSendAllowed`, which additionally asks İYS and re-reads the
 * opt-out at the moment of sending. This panel deliberately never says "you can
 * message them" — it says what was granted, when, through what, and whether it
 * reached the registry.
 *
 * The registry line is the one worth reading twice. A consent uploaded by the
 * `local` gateway is indistinguishable from a registered one in every column
 * but `iys_uploaded_via`, and P1b-T5 kept that column precisely so a human can
 * still tell. Showing the gateway's name — rather than a green tick — is what
 * carries that distinction to the person who would otherwise assume.
 */
export async function ConsentPanel({
  consents,
  registryName,
}: {
  consents: ContactConsent[];
  /**
   * The İYS gateway this deployment has configured, or null for none. Used to
   * explain a permission that is sitting in the queue with nowhere to go.
   */
  registryName: string | null;
}) {
  const [t, format] = await Promise.all([getTranslations("contacts"), getFormatter()]);
  const now = new Date();

  if (consents.length === 0) {
    return <p className="pb-(--card-py) text-body text-ink-400">{t("consent.none")}</p>;
  }

  const channelLabel = (channel: string | null): string => {
    if (channel === "email") return t("channelEmail");
    if (channel === "message") return t("channelMessage");
    if (channel === "call") return t("channelCall");
    return t("channelAny");
  };

  return (
    <ul className="flex flex-col gap-3 pb-(--card-py)">
      {consents.map((consent) => {
        const overdue =
          consent.type === "iys" &&
          consent.uploadedAt === null &&
          consent.uploadDueAt !== null &&
          consent.uploadDueAt.getTime() < now.getTime();

        return (
          <li
            key={`${consent.type}:${consent.channel ?? "any"}`}
            className="flex flex-col gap-1 border-b border-line-soft pb-3 last:border-b-0 last:pb-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-copy font-semibold text-foreground">
                {consent.type === "iys"
                  ? t("consent.iys", { channel: channelLabel(consent.channel) })
                  : t("consent.kvkk")}
              </span>

              <Badge variant={consent.state === "granted" ? "positive" : "destructive"}>
                {consent.state === "granted" ? t("consent.granted") : t("consent.revoked")}
              </Badge>

              {consent.grantedAt ? (
                <time dateTime={consent.grantedAt.toISOString()} className="text-meta text-faint">
                  {format.dateTime(consent.grantedAt, "short")}
                </time>
              ) : null}
            </div>

            {consent.source ? (
              <p className="text-meta text-faint">
                {t("consentSource", { source: consent.source })}
              </p>
            ) : null}

            {/* İYS registration, spelled out. KVKK has no registry to reach. */}
            {consent.type === "iys" ? (
              <p className="text-meta text-faint">
                {consent.uploadedAt
                  ? t("consent.uploaded", {
                      via: consent.uploadedVia ?? "—",
                      at: format.dateTime(consent.uploadedAt, "short"),
                    })
                  : overdue
                    ? t("consent.uploadOverdue", {
                        due: format.dateTime(consent.uploadDueAt as Date, "short"),
                      })
                    : consent.uploadDueAt
                      ? t("consent.uploadPending", {
                          due: format.dateTime(consent.uploadDueAt, "short"),
                        })
                      : t("consent.uploadUnknown")}
              </p>
            ) : null}

            {/*
              `local` is not a registration. Said in words rather than left to
              the reader to notice, because the whole reason the column exists
              is that the two look identical otherwise.
            */}
            {consent.uploadedVia && !isRegisteredVia(consent.uploadedVia) ? (
              <p className="text-meta text-state-negative-text">
                {t("consent.notRegistered", { via: consent.uploadedVia })}
              </p>
            ) : null}

            {consent.uploadError ? (
              <p className="text-meta text-state-negative-text">
                {t("consent.uploadError", { reason: consent.uploadError })}
              </p>
            ) : null}
          </li>
        );
      })}

      {registryName === null ? (
        <li className="text-meta text-faint">{t("consent.noGateway")}</li>
      ) : null}
    </ul>
  );
}
