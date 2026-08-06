import {
  CircleAlert,
  ClipboardList,
  MailX,
  MessageSquare,
  Send,
  ShieldCheck,
  ShieldX,
  Star,
  UserPlus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";
import Link from "next/link";
import { Stars } from "@/components/ds/stars";
import { SCALE } from "@/surveys/scoring";
import type { TimelineEvent } from "@/contacts/timeline";

/**
 * One person's history, newest first (P4-T1).
 *
 * The value of this list is the **order**, not the rows — every one of them is
 * readable somewhere else, but "we asked her twice, she never opened it, then
 * she walked in and left two stars" is a sentence nobody can assemble from four
 * screens.
 *
 * A rail with a dot per event rather than a table: the events have genuinely
 * different shapes (a review carries stars and a paragraph, a consent record
 * carries a channel and a source), and forcing them into shared columns would
 * mean four mostly-empty ones. The rail is what makes them read as one sequence
 * anyway.
 */

/** Icon and tint per kind. Tints are semantic — never indigo for "good". */
const LOOK: Record<TimelineEvent["kind"], { icon: LucideIcon; tone: string }> = {
  review: { icon: Star, tone: "bg-state-rating-bg text-state-rating-text" },
  request_sent: { icon: Send, tone: "bg-surface-sunken text-ink-500" },
  request_opened: { icon: Send, tone: "bg-surface-sunken text-ink-500" },
  request_failed: { icon: CircleAlert, tone: "bg-state-negative-bg text-state-negative-text" },
  consent_granted: { icon: ShieldCheck, tone: "bg-state-positive-bg text-state-positive-text" },
  consent_revoked: { icon: ShieldX, tone: "bg-state-negative-bg text-state-negative-text" },
  survey_sent: { icon: ClipboardList, tone: "bg-surface-sunken text-ink-500" },
  // The one event whose tint depends on its content: a detractor's answer is
  // the thing on this list somebody has to act on.
  survey_answered: { icon: ClipboardList, tone: "bg-state-accent-bg text-state-accent-text" },
  message_in: { icon: MessageSquare, tone: "bg-state-accent-bg text-state-accent-text" },
  message_out: { icon: MessageSquare, tone: "bg-surface-sunken text-ink-500" },
  unsubscribed: { icon: MailX, tone: "bg-state-negative-bg text-state-negative-text" },
  created: { icon: UserPlus, tone: "bg-surface-sunken text-ink-500" },
};

export async function ContactTimeline({ events }: { events: TimelineEvent[] }) {
  const [t, format] = await Promise.all([getTranslations("contacts"), getFormatter()]);
  const now = new Date();

  const channelLabel = (channel: string | null): string => {
    if (channel === "email") return t("channelEmail");
    if (channel === "message") return t("channelMessage");
    if (channel === "call") return t("channelCall");
    if (channel === "whatsapp") return t("channelWhatsapp");
    if (channel === "sms") return t("channelSms");
    if (channel === "link") return t("channelLink");
    return channel ?? "";
  };

  const headline = (event: TimelineEvent): string => {
    switch (event.kind) {
      case "review":
        return event.locationName
          ? t("eventReviewAt", { location: event.locationName })
          : t("eventReview");
      case "request_sent":
        return t("eventRequestSent", { channel: channelLabel(event.channel) });
      case "request_opened":
        return t("eventRequestOpened");
      case "request_failed":
        return t("eventRequestFailed", { channel: channelLabel(event.channel) });
      case "consent_granted":
        return event.consentType === "iys"
          ? t("eventConsentIys", { channel: channelLabel(event.channel) })
          : t("eventConsentKvkk");
      case "consent_revoked":
        return event.consentType === "iys"
          ? t("eventConsentIysRevoked", { channel: channelLabel(event.channel) })
          : t("eventConsentKvkkRevoked");
      case "survey_sent":
        return t("eventSurveySent", { survey: event.surveyName });
      case "survey_answered":
        return t("eventSurveyAnswered", {
          survey: event.surveyName,
          score: event.score,
          max: SCALE[event.surveyType].max,
        });
      case "message_in":
        return t("eventMessageIn", { channel: channelLabel(event.channel) });
      case "message_out":
        return event.status === "failed"
          ? t("eventMessageFailed", { channel: channelLabel(event.channel) })
          : t("eventMessageOut", { channel: channelLabel(event.channel) });
      case "unsubscribed":
        return t("eventUnsubscribed");
      case "created":
        return t("eventCreated");
    }
  };

  return (
    <ol className="flex flex-col gap-0 pb-(--card-py)">
      {events.map((event, index) => {
        const look = LOOK[event.kind];
        const Icon = look.icon;
        const last = index === events.length - 1;

        return (
          <li key={`${event.kind}:${event.at.getTime()}:${index}`} className="flex gap-3">
            {/* The rail: a dot, and a line that stops at the last event. */}
            <div className="flex flex-col items-center">
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full ${look.tone}`}
              >
                <Icon className="size-3.5" aria-hidden />
              </span>
              {last ? null : <span className="w-px flex-1 bg-line-soft" aria-hidden />}
            </div>

            <div className={`min-w-0 flex-1 ${last ? "pb-0" : "pb-4"}`}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-copy font-medium text-foreground">{headline(event)}</span>
                <time
                  dateTime={event.at.toISOString()}
                  title={format.dateTime(event.at, "short")}
                  className="text-meta text-faint"
                >
                  {format.relativeTime(event.at, now)}
                </time>
              </div>

              {event.kind === "review" ? (
                <div className="mt-1 flex flex-col gap-1">
                  {event.rating === null ? null : (
                    <Stars
                      rating={event.rating}
                      srLabel={t("starsLabel", { rating: event.rating })}
                      className="text-state-rating-text"
                    />
                  )}
                  {event.text ? (
                    <p className="line-clamp-3 text-body text-pretty text-ink-400">{event.text}</p>
                  ) : null}
                  <Link
                    href={`/reviews?review=${event.reviewId}`}
                    className="w-fit rounded-sm text-meta font-semibold text-primary transition-colors hover:text-indigo-700 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {t("openInInbox")}
                  </Link>
                </div>
              ) : null}

              {event.kind === "survey_answered" ? (
                <div className="mt-1 flex flex-col gap-1">
                  {event.comment ? (
                    <p className="line-clamp-3 text-body text-pretty text-ink-400">
                      {event.comment}
                    </p>
                  ) : null}
                  {/*
                    The private follow-up, marked as private. It was given under
                    a different promise from the score beside it — "what went
                    wrong, and may we put it right" — and a reader skimming this
                    list needs to know which of the two they are looking at.
                  */}
                  {event.followUpComment ? (
                    <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
                      <p className="text-eyebrow text-faint uppercase">{t("privateFollowUp")}</p>
                      <p className="mt-0.5 text-body text-pretty text-ink-400">
                        {event.followUpComment}
                      </p>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/*
                The message itself. Both directions, because a thread read as a
                list of "sent a message / received a message" tells you when
                somebody was in touch and nothing about what was said.
              */}
              {event.kind === "message_in" || event.kind === "message_out" ? (
                <div className="mt-1 flex flex-col gap-1">
                  {event.body ? (
                    <p className="line-clamp-3 text-body text-pretty text-ink-400">{event.body}</p>
                  ) : null}
                  {event.kind === "message_out" && event.failureReason ? (
                    <p className="text-meta text-state-negative-text">{event.failureReason}</p>
                  ) : null}
                </div>
              ) : null}

              {event.kind === "request_sent" && event.campaignName ? (
                <p className="text-meta text-faint">{event.campaignName}</p>
              ) : null}

              {event.kind === "request_failed" && event.reason ? (
                <p className="text-meta text-faint">{event.reason}</p>
              ) : null}

              {event.kind === "consent_granted" && event.source ? (
                <p className="text-meta text-faint">
                  {t("consentSource", { source: event.source })}
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
