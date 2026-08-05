import { randomUUID } from "node:crypto";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";

/**
 * SMS, as a seam (P4-T3).
 *
 * Modelled on `src/compliance/iys-gateway.ts` rather than on the review
 * connectors, and the difference matters. A review source is something a
 * business *connects* — it has OAuth, capabilities, a sync schedule, a card in
 * the Locations screen. An SMS gateway is none of those: it is a piece of
 * deployment plumbing, chosen once by whoever runs the installation, and
 * putting it in `PROVIDERS` would offer "connect SMS" as a review source on a
 * screen where that sentence means nothing.
 *
 * **The default is `none`, which refuses.** In Türkiye an SMS gateway is also
 * the İYS integration — the same BSP that carries the message reports the
 * permission — so a deployment that has not chosen one cannot send commercial
 * SMS *and should not be able to*. There is deliberately no implementation here
 * that could be mistaken for a real one; `mock` accepts without leaving the
 * machine, and says so in every id it mints.
 */

const log = childLogger({ module: "messaging/sms" });

export type SmsSendResult =
  { ok: true; messageId: string } | { ok: false; reason: string; retryable: boolean };

export type SmsClient = {
  readonly name: string;
  send(input: { to: string; body: string }): Promise<SmsSendResult>;
};

/** Prefixed so it can never be mistaken for a gateway reference. */
export const MOCK_SMS_PREFIX = "sms.mock-";

/**
 * Accepts everything and reaches nobody. **Never valid in production**, for the
 * same reason `createLocalGateway` is not: a message id implies a message, and
 * one minted here corresponds to nothing that ever left the building.
 */
export function createMockSmsClient(nodeEnv: string): SmsClient {
  return {
    name: "mock",
    async send({ to }): Promise<SmsSendResult> {
      if (nodeEnv === "production") {
        log.error(
          "SMS_GATEWAY=mock reached production. Refusing: a mock message id claims a delivery " +
            "that never happened.",
        );
        return { ok: false, retryable: false, reason: "The SMS gateway is not configured." };
      }

      log.info({ to: `${to.slice(0, 5)}…` }, "SMS not sent (mock gateway)");
      return { ok: true, messageId: `${MOCK_SMS_PREFIX}${randomUUID()}` };
    },
  };
}

/**
 * The gateway this environment selected, or null when it has none.
 *
 * Null rather than a throw, exactly as `getWhatsAppClient` does it: having no
 * SMS gateway is the normal state today and every caller already handles a
 * refusal.
 */
export function getSmsClient(): SmsClient | null {
  const env = getEnv();
  return env.SMS_GATEWAY === "mock" ? createMockSmsClient(env.NODE_ENV) : null;
}

/**
 * Did a real gateway carry this message?
 *
 * The SMS twin of `isRegisteredVia` and `CompetitorSource.isReal`, and empty
 * for the same reason: nothing here has ever reached a phone. A real BSP
 * adapter adds its name when it lands, and every screen asking this question
 * starts telling the truth on the same commit.
 */
const REAL_GATEWAYS: readonly string[] = [];

export function isRealSmsGateway(name: string | null): boolean {
  return name !== null && REAL_GATEWAYS.includes(name);
}
