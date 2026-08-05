import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **Every path that can send, and whether it is gated** (P4-T7).
 *
 * `docs/20` asks for an explicit consent-gate test. The *behaviour* — a refusal
 * with a named reason for somebody who never consented — is asserted in four
 * places already, each beside the code it belongs to:
 *
 *   - `tests/db/compliance-gate.test.ts` — the gate itself, every branch
 *   - `tests/db/messaging.test.ts` — WhatsApp templates, session replies, SMS
 *   - `tests/db/surveys.test.ts` — survey invitations
 *   - `tests/db/broadcasts.test.ts` — every recipient of a broadcast, and the
 *     review-request kind that the *direct* sender does not gate
 *
 * What none of those can tell you is whether the list is **complete**. Each
 * proves a door is locked; none notices a new door. That is this file's job,
 * and it is the same shape as `tests/db/public-leakage.test.ts`'s last test:
 * enumerate the surface from disk, pin it, and fail when it grows.
 *
 * It reads source rather than running anything, deliberately. The question here
 * is not "does this refuse" — that is answered above — but "does this module
 * ask the gate at all", and a module that never calls `checkSendAllowed` cannot
 * refuse anything however carefully the rest of it is written.
 *
 * The classification is the actual rule:
 *
 *   - **`customer`** — reaches a member of the public. Needs consent, always.
 *   - **`team`** — reaches somebody who works at the business, about their own
 *     business: an alert, a digest, a report. Not a commercial message, and
 *     demanding an İYS permission from a manager before telling them about
 *     their own one-star review would be a misreading of the regime rather than
 *     caution.
 */

/** What can put a message on the wire. Nothing else in `src/` sends anything. */
const TRANSPORT_CALLS = [
  "getEmailTransport(",
  "getSmsClient(",
  "getWhatsAppClient(",
  ".sendText(",
  ".sendTemplate(",
];

/**
 * The transports themselves. They *are* the wire, so they are not callers of
 * it — gating inside a transport would put the rule below the layer that knows
 * who the recipient is.
 */
const TRANSPORT_MODULES = new Set([
  "messaging/email.ts",
  "messaging/sms.ts",
  "connectors/whatsapp/client.ts",
  "connectors/whatsapp/mock-client.ts",
]);

type SendPath = {
  audience: "customer" | "team";
  /** Whether this module calls `checkSendAllowed` before it reaches a client. */
  gated: boolean;
  why: string;
};

/**
 * Every module that reaches a transport, who it reaches, and whether it gates.
 *
 * The one ungated customer path is named rather than omitted. A list that
 * quietly left it out would be a list that lies, and the value of an
 * enumeration is entirely in it being true.
 */
const SEND_PATHS: Record<string, SendPath> = {
  "collect/requests.ts": {
    audience: "customer",
    gated: false,
    why:
      "Review requests over email (P1b-T1). Honours the opt-out — see the " +
      "`unsubscribedAt` check below, which this file asserts rather than takes " +
      "on trust — but does not pass the İYS gate. A Phase 1 behaviour that " +
      "predates the gate, left alone rather than changed because gating it " +
      "would stop review requests sending in every deployment without a " +
      "registry, which is all of them today. The same send *inside a broadcast* " +
      "is gated: `broadcasts/pipeline.ts` puts every recipient of every kind " +
      "through `checkSendAllowed`. Closing this is a go-live step, not a test.",
  },
  "surveys/send.ts": {
    audience: "customer",
    gated: true,
    why: "Survey invitations (P4-T2). Gates each recipient inside `prepareInvites`.",
  },
  "messaging/whatsapp.ts": {
    audience: "customer",
    gated: true,
    why:
      "WhatsApp (P1b-T3). Both entry points gate: a template as `commercial`, " +
      "free text as `service`, which needs the customer's own 24-hour window.",
  },
  "messaging/outbound.ts": {
    audience: "customer",
    gated: true,
    why: "SMS (P4-T3). `sendSms` gates as `commercial` — SMS has no service window.",
  },
  "notifications/email.ts": {
    audience: "team",
    gated: false,
    why: "New-review and SLA alerts, to the people who work there.",
  },
  "digest/delivery.ts": {
    audience: "team",
    gated: false,
    why: "The weekly Action Digest, to the team that subscribed to it.",
  },
  "reports/pipeline.ts": {
    audience: "team",
    gated: false,
    why: "Scheduled PDF reports, to the member who scheduled one for themselves.",
  },
  "auth/config.ts": {
    audience: "team",
    gated: false,
    why:
      "Two transactional emails to a person, not a customer: the team invitation " +
      "(W1.9) and the password reset (W1.9b). A one-off request to join a workspace, " +
      "and a reply to somebody who has just asked for a way back into their own " +
      "account. Neither has an ongoing subscription to opt out of, and demanding an " +
      "İYS permission before a business may invite its own manager — or before a " +
      "locked-out user may recover — is a misreading of the regime, not caution. " +
      "Neither carries an unsubscribe footer for the same reason: offering one would " +
      "imply a list they are on.",
  },
};

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path, `${prefix}${entry.name}/`);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")
      ? [`${prefix}${entry.name}`]
      : [];
  });
}

const read = (file: string) => readFileSync(join("src", file), "utf8");

describe("the outbound surface", () => {
  it("is exactly the paths enumerated here, so a new one cannot arrive unexamined", () => {
    const reaching = sourceFiles("src")
      .filter((file) => !TRANSPORT_MODULES.has(file))
      .filter((file) => TRANSPORT_CALLS.some((call) => read(file).includes(call)))
      .sort();

    expect(reaching).toEqual(Object.keys(SEND_PATHS).sort());
  });

  it("says who each one reaches, and why", () => {
    // Not decoration. `team` is the only reason a send may skip the gate, so
    // the classification *is* the argument — and writing it down is what stops
    // a customer-facing path being quietly filed there later.
    for (const [file, path] of Object.entries(SEND_PATHS)) {
      expect(["customer", "team"], file).toContain(path.audience);
      expect(path.why.length, `${file} has no reasoning`).toBeGreaterThan(40);
    }
  });
});

describe("consent is asked before a customer is messaged", () => {
  it("calls the gate on every customer-facing path that claims to", () => {
    for (const [file, path] of Object.entries(SEND_PATHS)) {
      if (path.audience !== "customer" || !path.gated) continue;

      // Whether it *refuses* correctly is asserted in the DB suites named at
      // the top. Whether it asks at all can only be seen from here.
      expect(read(file), `${file} claims to gate and never calls checkSendAllowed`).toContain(
        "checkSendAllowed(",
      );
    }
  });

  it("holds the ungated review-request path to the opt-out it does claim", () => {
    /**
     * The exception, pinned to the promise made for it. This send goes out
     * without an İYS check, so the one protection a customer has is that
     * "stop" works — and that is a line of code somebody could delete while
     * tidying, with no test anywhere going red.
     */
    const source = read("collect/requests.ts");
    expect(source).toContain("unsubscribedAt");
  });

  it("keeps the broadcast pipeline gating, even though it sends through others", () => {
    // Not in the enumeration above, because it reaches no transport itself —
    // it calls the senders. It gates anyway, which is what makes a *broadcast*
    // review request safe when the direct one is not.
    expect(read("broadcasts/pipeline.ts")).toContain("checkSendAllowed(");
  });

  it("lets no send path decide for itself whether İYS applies", () => {
    /**
     * The gate refuses when İYS is required and no gateway is installed, and
     * `IYS_GATEWAY=none` is the default — that is the posture the whole product
     * ships in. So the thing to guard against is not a missing call but a
     * *second* decision point: a sender that reads `IYS_REQUIRED` itself, or
     * asks for the gateway and branches on the answer, has quietly moved the
     * rule to where it can be argued with.
     *
     * The two modules outside `src/compliance/` that legitimately consult the
     * registry — the contact page, which shows its name, and the upload worker,
     * which has nothing to do if there is none — send nothing, and neither is
     * on this list.
     */
    for (const file of Object.keys(SEND_PATHS)) {
      const source = read(file);
      expect(source, `${file} decides İYS applicability itself`).not.toContain("iysRequired(");
      expect(source, `${file} reaches for the gateway directly`).not.toContain("getIysGateway(");
    }
  });

  it("gives a caller no way to name the intent a send goes out under", () => {
    /**
     * `intentFor` is a pure function of the channel and the message kind, and
     * `sendMessage` takes no `intent` — so "this one is a service message" is
     * not a sentence any caller can say. That is the shape that makes the gate
     * unarguable, and it is worth a test rather than a comment, because adding
     * an optional parameter is a one-line change that looks helpful.
     */
    const outbound = read("messaging/outbound.ts");
    expect(outbound).toContain("export function intentFor(");

    const input = outbound.slice(outbound.indexOf("export type SendMessageInput = {"));
    expect(input.slice(0, input.indexOf("};"))).not.toContain("intent");
  });
});
