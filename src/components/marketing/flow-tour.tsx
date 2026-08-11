"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Stars } from "@/components/ds/stars";
import { REDUCED_MOTION, useMediaQuery } from "@/components/marketing/use-media-query";
import { cn } from "@/lib/utils";

/**
 * The five-step tour: Collect → Inbox → Understood → Reply → Monday plan.
 *
 * The section's claim is "this is the product, not a metaphor", so the stage
 * draws a plain product window rather than a device mockup or a screenshot. A
 * screenshot goes stale silently and has to be re-shot per locale; this is
 * built from the same words the rest of the page is, so Turkish gets a Turkish
 * product rather than an English one with a caption underneath.
 *
 * ## The window is drawn in the product's palette, deliberately
 *
 * `globals.css` already makes this argument about the briefing card: "a demo
 * that renders the product in a typeface the product does not have is a demo
 * that lies about what you get". The same holds for colour and for the type
 * ramp. So the *page* around this component is the brand layer — paper, Lora,
 * the warm hairline — and everything inside the window frame is `docs/15`:
 * `--canvas`, `--line`, `--ink-350`, `--indigo-600`, and the ramp's own steps.
 * Nothing here invents a size or a grey, because the thing being depicted
 * already has one. (The landing concept hardcoded these as hex; every value it
 * used turned out to be a product token read off the app with an eyedropper,
 * which is the strongest argument available that they should be tokens here.)
 *
 * **Everything on the stage is invented, and the page says so.** The reviews,
 * the draft and the plan are written for this page — `docs/24` §5's rule about
 * the murmur ("never real review text") is a rule about personal data and
 * applies here for the same reason. The digest delta is a worked example and
 * carries no "results you will get" framing anywhere near it; `PRODUCT.md`
 * forbids uplift figures and this is not one.
 *
 * ## Why the timer is written the way it is
 *
 * Three things stop the tour: leaving the viewport, the pointer entering it,
 * and (via the interval being torn down) a click. The first two are the
 * interesting ones — a panel that keeps advancing while somebody reads the
 * step they just chose is the failure everyone has met on a carousel. A click
 * restarts the interval rather than only setting the index, so the reader gets
 * a whole period on the step they picked.
 *
 * `prefers-reduced-motion` is honoured in three separate places because it
 * means three different things: the progress bar stops filling (CSS), the
 * draft stops typing (below), and the section stops sliding (`globals.css`).
 */

/**
 * The stage's panels, in tour order, with their keys written out.
 *
 * `crumb`, `title` and `body` are literals rather than `flow.${id}Title`
 * because `scripts/check-i18n.mts` can only see a key it can read as a string
 * — and a catalogue entry no static check can find is one nobody dares delete.
 */
const STEPS = [
  { id: "ask", crumb: "mock.collect", title: "flow.askTitle", body: "flow.askBody" },
  { id: "inbox", crumb: "mock.all", title: "flow.inboxTitle", body: "flow.inboxBody" },
  { id: "read", crumb: "mock.understood", title: "flow.readTitle", body: "flow.readBody" },
  { id: "reply", crumb: "mock.reply", title: "flow.replyTitle", body: "flow.replyBody" },
  { id: "plan", crumb: "mock.digest", title: "flow.planTitle", body: "flow.planBody" },
] as const;

/** Milliseconds a step holds before the tour advances on its own. */
const STEP_MS = 5200;

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md border border-line bg-surface-sunken px-2 py-1 text-meta font-semibold text-ink-600">
      {children}
    </span>
  );
}

function Avatar({
  letter,
  tone = "indigo",
}: {
  letter: string;
  tone?: "indigo" | "positive" | "grey";
}) {
  const tones = {
    indigo: "bg-indigo-050 text-indigo-600",
    positive: "bg-state-positive-bg text-state-positive-text",
    grey: "bg-surface-sunken text-ink-500",
  } as const;

  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 flex-none items-center justify-center rounded-full text-meta font-bold",
        tones[tone],
      )}
    >
      {letter}
    </span>
  );
}

/**
 * A row in the mock window.
 *
 * The entrance is a transition rather than a keyframe so that re-entering a
 * panel replays it: the panel unmounts when it is not current, so every visit
 * starts from the un-entered state for free.
 */
function Row({
  children,
  delay = 0,
  last = false,
}: {
  children: React.ReactNode;
  delay?: number;
  last?: boolean;
}) {
  return (
    <div
      className={cn("panel-row flex gap-3 px-1.5 py-3", !last && "border-b border-line-soft")}
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/** The name above a row — the source, or who wrote it. */
function Who({ children }: { children: React.ReactNode }) {
  return <div className="mb-0.5 text-meta text-faint">{children}</div>;
}

export function FlowTour() {
  const t = useTranslations("marketing");
  const [current, setCurrent] = useState(0);
  const [held, setHeld] = useState(false);
  const [running, setRunning] = useState(false);
  const [sent, setSent] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const step = STEPS[current]!;

  /* Only run while the tour is on screen. An interval ticking behind four
     screens of page is work nobody can see. */
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setRunning(Boolean(entry?.isIntersecting)),
      { threshold: 0.25 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* `current` is in the dependency list on purpose: a click changes it, the
     effect re-creates the interval, and the reader gets a whole period on the
     step they chose rather than the remainder of the previous one. */
  useEffect(() => {
    if (!running || held) return;
    const id = setInterval(() => setCurrent((index) => (index + 1) % STEPS.length), STEP_MS);
    return () => clearInterval(id);
  }, [running, held, current]);

  const go = useCallback((index: number) => {
    setCurrent(index);
    setSent(false);
  }, []);

  return (
    <div
      ref={root}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      className="grid items-stretch gap-8 lg:grid-cols-[340px_1fr]"
    >
      {/* A tablist: five controls swapping one region. Naming it so is what
          gives a keyboard the arrow keys and a screen reader the "3 of 5" it
          would otherwise have to infer from a decorative number glyph. */}
      <div className="flex flex-col gap-2.5" role="tablist" aria-label={t("flow.title")}>
        {STEPS.map(({ id, title, body }, index) => {
          const active = index === current;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              id={`flow-tab-${id}`}
              aria-selected={active}
              aria-controls={`flow-panel-${id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => go(index)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                const next =
                  event.key === "ArrowDown"
                    ? (index + 1) % STEPS.length
                    : (index - 1 + STEPS.length) % STEPS.length;
                go(next);
                document.getElementById(`flow-tab-${STEPS[next]!.id}`)?.focus();
              }}
              className={cn(
                "relative flex flex-col justify-center overflow-hidden rounded-xl border bg-white px-4 py-4 text-start transition-[flex-grow,border-color] duration-300 lg:flex-1",
                active ? "border-brand-ink lg:grow-[3.2]" : "border-paper-line",
              )}
            >
              <span className="font-mono text-meta text-paper-faint">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="mt-1 mb-1 text-lead font-semibold">{t(title)}</span>
              <span
                className={cn(
                  "overflow-hidden text-copy text-paper-faint transition-[max-height,opacity,margin] duration-300",
                  active ? "mt-1 max-h-52 opacity-100" : "max-h-0 opacity-0",
                )}
              >
                {t(body)}
              </span>
              {active && (
                <span
                  aria-hidden
                  key={`${id}-${current}`}
                  className="flow-bar absolute inset-x-0 bottom-0 h-0.5 bg-amber-500"
                  style={{
                    animationDuration: `${STEP_MS}ms`,
                    animationPlayState: held ? "paused" : "running",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center rounded-2xl border border-paper-line bg-canvas p-6">
        <div className="mx-auto w-full max-w-[600px] overflow-hidden rounded-xl border border-line bg-white">
          <div className="flex items-center gap-2.5 border-b border-line-inner px-4 py-2.5 text-copy font-semibold">
            {/* The seal is a file, never a redraw (docs/24 §2). */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/fairfame-symbol.svg" alt="" aria-hidden width={18} height={18} />
            <span>{t("mock.inbox")}</span>
            <span className="font-medium text-faint">{t(step.crumb)}</span>
          </div>

          <div
            role="tabpanel"
            id={`flow-panel-${step.id}`}
            aria-labelledby={`flow-tab-${step.id}`}
            className="flow-panel p-4"
            key={step.id}
          >
            {step.id === "ask" && <AskPanel />}
            {step.id === "inbox" && <InboxPanel />}
            {step.id === "read" && <ReadPanel />}
            {step.id === "reply" && (
              <ReplyPanel sent={sent} onSend={() => setSent(true)} onDone={() => go(4)} />
            )}
            {step.id === "plan" && <PlanPanel />}
          </div>
        </div>
      </div>
    </div>
  );
}

function AskPanel() {
  const t = useTranslations("marketing");
  return (
    <>
      <div className="mb-3.5 flex flex-wrap gap-2">
        <Chip>{t("channel.whatsapp")}</Chip>
        <Chip>{t("channel.email")}</Chip>
        <Chip>{t("channel.sms")}</Chip>
        <Chip>{t("channel.qr")}</Chip>
      </div>
      <Row>
        <Avatar letter="Q" tone="positive" />
        <div>
          <Who>{t("request.to")}</Who>
          <div className="text-copy">{t("request.message")}</div>
          <div className="mt-2.5">
            <span className="inline-block rounded-md bg-state-positive-bg px-2 py-0.5 text-eyebrow font-semibold text-state-positive-text">
              {t("request.consent")}
            </span>
          </div>
        </div>
      </Row>
      <Row delay={250} last>
        <Avatar letter="i" tone="grey" />
        <div className="text-copy text-faint">{t("request.note")}</div>
      </Row>
    </>
  );
}

function InboxPanel() {
  const t = useTranslations("marketing");
  return (
    <>
      <div className="mb-3.5 flex flex-wrap gap-2">
        <Chip>Google</Chip>
        <Chip>WhatsApp</Chip>
        <Chip>Instagram</Chip>
        <Chip>Facebook</Chip>
        <Chip>TripAdvisor</Chip>
        <Chip>Trustpilot</Chip>
        <Chip>{t("channel.more")}</Chip>
      </div>
      <Row>
        <Avatar letter="D" />
        <div>
          <Who>{t("review.oneName")}</Who>
          <Stars rating={2} srLabel={t("starsLabel", { rating: 2 })} size="sm" />
          <div className="text-copy">{t("review.oneText")}</div>
        </div>
      </Row>
      <Row delay={250}>
        <Avatar letter="A" />
        <div>
          <Who>{t("review.twoName")}</Who>
          <Stars rating={5} srLabel={t("starsLabel", { rating: 5 })} size="sm" />
          <div className="text-copy">{t("review.twoText")}</div>
        </div>
      </Row>
      <Row delay={500} last>
        <Avatar letter="W" tone="positive" />
        <div>
          <Who>{t("review.threeName")}</Who>
          <div className="text-copy">{t("review.threeText")}</div>
        </div>
      </Row>
    </>
  );
}

function ReadPanel() {
  const t = useTranslations("marketing");
  return (
    <Row last>
      <Avatar letter="D" />
      <div>
        <Who>{t("review.oneName")}</Who>
        <Stars rating={2} srLabel={t("starsLabel", { rating: 2 })} size="sm" />
        <div className="text-copy">
          {/* The highlight is a background wash rather than a <mark>: this is
              the page pointing at a sentence, not the document marking it. */}
          <span className="bg-amber-050">{t("review.oneText")}</span>
        </div>
        <div className="mt-2.5">
          <span className="inline-block rounded-md bg-state-negative-bg px-2 py-0.5 text-eyebrow font-semibold text-state-negative-text">
            {t("badge.negative")}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {(["topic.delay", "topic.service"] as const).map((topic) => (
            <span
              key={topic}
              className="inline-block rounded-md border border-dashed border-graphic-faint px-2 py-0.5 text-eyebrow font-semibold text-ink-600"
            >
              {t(topic)}
            </span>
          ))}
        </div>
      </div>
    </Row>
  );
}

/**
 * The draft, typed out.
 *
 * The one place the page animates *text*, and it earns it: the step's claim is
 * that a draft is written for you, and a finished block of text asserts that
 * where writing it in front of the reader shows it. Under
 * `prefers-reduced-motion` the whole text is present on the first frame — the
 * claim survives, the motion does not.
 */
function ReplyPanel({
  sent,
  onSend,
  onDone,
}: {
  sent: boolean;
  onSend: () => void;
  onDone: () => void;
}) {
  const t = useTranslations("marketing");
  const full = t("draft.text");
  const reduced = useMediaQuery(REDUCED_MOTION);
  const [typed, setTyped] = useState("");

  /* The preference is read at render rather than written into state by an
     effect, so "no motion" is a branch in the output instead of a second pass
     that briefly types anyway. The only state update left is the tick, which
     happens inside the interval's own callback. */
  const shown = reduced ? full : typed;

  useEffect(() => {
    if (reduced) return;
    let index = 0;
    const id = setInterval(() => {
      index += 2;
      setTyped(full.slice(0, index));
      if (index >= full.length) clearInterval(id);
    }, 24);
    return () => clearInterval(id);
  }, [full, reduced]);

  /* Approving jumps to the plan, which is the loop this section is about: a
     reply you sent is a line in Monday's plan. */
  useEffect(() => {
    if (!sent) return;
    const id = setTimeout(onDone, 1400);
    return () => clearTimeout(id);
  }, [sent, onDone]);

  return (
    <>
      <div className="flex gap-3 px-1 pb-1">
        <Avatar letter="D" />
        <div>
          <Who>{t("review.oneName")}</Who>
          <div className="text-copy">{t("review.oneText")}</div>
        </div>
      </div>
      <div className="mt-3 rounded-xl border border-line bg-surface-sunken px-4 py-3">
        <div className="mb-2 text-eyebrow text-faint uppercase">{t("draft.label")}</div>
        {/* Announced once, from the label, rather than as it arrives: a live
            region fed a typewriter two characters at a time is a screen reader
            reading one sentence forty times. */}
        <p className="min-h-[84px] text-body" aria-label={full}>
          <span aria-hidden>{shown}</span>
          {shown.length < full.length && (
            <span
              aria-hidden
              className="caret ms-px inline-block h-3.5 w-px bg-brand-ink align-[-2px]"
            />
          )}
        </p>
        <div className="mt-3 flex gap-2.5">
          <button
            type="button"
            className="tap rounded-lg border border-line bg-white px-3.5 py-2 text-copy font-semibold"
          >
            {t("draft.edit")}
          </button>
          <button
            type="button"
            onClick={onSend}
            className="tap rounded-lg border border-indigo-600 bg-indigo-600 px-3.5 py-2 text-copy font-semibold text-white"
          >
            {t("draft.approve")}
          </button>
        </div>
        {sent && (
          <p className="mt-2.5 text-copy text-state-positive-text" role="status">
            ✓ {t("draft.sent")}
          </p>
        )}
      </div>
    </>
  );
}

function PlanPanel() {
  const t = useTranslations("marketing");
  return (
    <>
      <p className="mt-0.5 mb-2 text-eyebrow text-faint uppercase">{t("mock.digest")}</p>
      <ol>
        {(["digest.one", "digest.two", "digest.three"] as const).map((key, index) => (
          <li
            key={key}
            className="panel-row flex gap-3 border-b border-line-soft px-1 py-3"
            style={{ animationDelay: `${index * 250}ms` }}
          >
            {/* `--amber-ink`, not `--amber-500`: this is an ordinal a reader has
                to read, and amber-500 is 2.04:1 on white. Amber at text weight
                is exactly what `--amber-ink` exists for. */}
            <span className="w-[18px] flex-none font-mono text-copy font-bold text-amber-ink">
              {index + 1}
            </span>
            <span className="text-body">{t(key)}</span>
          </li>
        ))}
      </ol>
      <p className="pt-3 font-mono text-meta text-faint">{t("digest.delta")}</p>
    </>
  );
}
