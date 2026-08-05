import { randomUUID } from "node:crypto";
import { renderTemplate } from "./templates.ts";
import type { SendResult, WhatsAppClient } from "./client.ts";

/**
 * A WhatsApp client that accepts everything and reaches nobody (P4-T3).
 *
 * **Why this exists.** `getWhatsAppClient()` returns null without credentials,
 * which is correct — but it also meant that until now no conversation could
 * round-trip anywhere: T3's Definition of Done ("a mock conversation
 * round-trips") was unreachable in an environment without a WhatsApp Business
 * Account, which is every environment there has ever been. `CONNECTOR_WHATSAPP_MODE`
 * already distinguishes `mock` from `real`; this is what `mock` now means.
 *
 * **It is not a simulator and does not pretend to be.** It performs no
 * validation Meta would perform, knows nothing about template approval or
 * quality ratings, and never fails. `src/connectors/mock-platform` is the thing
 * that disagrees with the connector — a fake Graph API on a real socket, with
 * error envelopes and rate limits — and it stays the way to exercise failure.
 * This is for the case where there is no socket at all and somebody wants to
 * see the product work.
 *
 * The message id is prefixed so it can never be mistaken for a real `wamid`
 * in a database, a log, or a support conversation.
 */

export const MOCK_MESSAGE_PREFIX = "wamid.mock-";

export function createMockWhatsAppClient(): WhatsAppClient {
  const accept = (): SendResult => ({
    ok: true,
    messageId: `${MOCK_MESSAGE_PREFIX}${randomUUID()}`,
    waId: null,
  });

  return {
    async sendTemplate(input) {
      // Rendered even though nothing is transmitted: `renderTemplate` throws on
      // a variable-count mismatch, and catching that in development is most of
      // what a mock is for. Silently accepting a broken template would make the
      // mock *less* useful than no client at all.
      renderTemplate(input.template, input.locale, input.values);
      return accept();
    },

    async sendText() {
      return accept();
    },

    async markRead() {
      // Nothing to mark. Deliberately not an error: a caller that marks a
      // thread read should not have to know which client it has.
    },
  };
}
