import { createMetaCorpus, type MetaCorpus } from "./meta-corpus.ts";
import type { MockRequest, MockResponse } from "./google.ts";

/**
 * A fake Meta Graph API — Instagram *and* WhatsApp.
 *
 * One mock for both because there is one API: `graph.facebook.com/v21.0` serves
 * an Instagram account's media and a WhatsApp number's messages from the same
 * host, and both connectors already point at it through the same `baseUrl`
 * seam. Splitting them here would invent a boundary the platform does not have.
 *
 * The error envelope is Meta's, not Google's — `{ error: { message, type, code,
 * fbtrace_id } }`, with the numeric codes the connectors actually branch on.
 * That difference is exactly why a shared "generic mock" would have been worth
 * nothing: the whole value is in being wrong in the same way the real thing is.
 */

export type MetaMockOptions = {
  /** The Instagram business account id. */
  accountId?: string;
  username?: string;
  /** The WhatsApp phone number id that sends. */
  phoneNumberId?: string;
  backfill?: number;
  dripMs?: number;
  seed?: string;
  validTokens?: string[];
  now?: () => Date;
  /**
   * Whether `instagram_manage_messages` has been granted. Defaults to true.
   *
   * Set false to model the common pre-app-review state: comments work, the DM
   * edge refuses with a permission error, and the connector has to keep going.
   */
  messagingGranted?: boolean;
};

const DEFAULT_ACCOUNT = "17841400000000001";
const DEFAULT_PHONE_NUMBER_ID = "109876543210987";

function json(status: number, body: unknown, headers: Record<string, string> = {}): MockResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

/** Meta's envelope, matching `tests/fixtures/{instagram,whatsapp}/error-*.json`. */
function metaError(
  status: number,
  code: number,
  message: string,
  headers?: Record<string, string>,
) {
  return json(
    status,
    { error: { message, type: "OAuthException", code, fbtrace_id: "MockTraceId" } },
    headers,
  );
}

export function createMetaMock(options: MetaMockOptions = {}) {
  const accountId = options.accountId ?? DEFAULT_ACCOUNT;
  const username = options.username ?? "kahvemolasi";
  const phoneNumberId = options.phoneNumberId ?? DEFAULT_PHONE_NUMBER_ID;
  const now = options.now ?? (() => new Date());
  const validTokens = new Set(options.validTokens ?? []);
  const messagingGranted = options.messagingGranted ?? true;

  const corpus: MetaCorpus = createMetaCorpus({
    accountId,
    username,
    backfill: options.backfill,
    dripMs: options.dripMs,
    seed: options.seed,
    startedAt: now(),
  });

  /** Every message the fake WhatsApp accepted, so a test can assert on sends. */
  const sent: { to: string; body: string; messageId: string }[] = [];

  let throttleNext: { retryAfterSeconds: number } | null = null;
  let messageCounter = 0;

  function authorized(request: MockRequest): boolean {
    const header = request.headers.authorization ?? request.headers.Authorization;
    if (!header?.startsWith("Bearer ")) return false;
    if (validTokens.size === 0) return true;
    return validTokens.has(header.slice("Bearer ".length));
  }

  function handle(request: MockRequest): MockResponse {
    const url = new URL(request.url, "http://mock.local");
    const path = url.pathname.replace(/\/+$/, "");

    if (throttleNext) {
      const { retryAfterSeconds } = throttleNext;
      throttleNext = null;
      // 130429 is the code the WhatsApp client classifies as a rate limit; the
      // Instagram client keys on its own set, and both reach the shared
      // throttle through the 429 status.
      return metaError(429, 130429, "(#130429) Rate limit hit", {
        "retry-after": String(retryAfterSeconds),
      });
    }

    if (!authorized(request)) {
      // 190 is Meta's expired/invalid token — the one that must be
      // distinguishable from a permission failure, because only it is fixable
      // by refreshing.
      return metaError(401, 190, "Error validating access token: Session has expired.");
    }

    // POST /{phoneNumberId}/messages — WhatsApp send.
    const sendMatch = /^\/([^/]+)\/messages$/.exec(path);
    if (request.method === "POST" && sendMatch) {
      if (sendMatch[1] !== phoneNumberId) {
        return metaError(403, 200, "Permissions error: unknown phone number id.");
      }

      let payload: { to?: unknown; text?: { body?: unknown } };
      try {
        payload = JSON.parse(request.body || "{}") as typeof payload;
      } catch {
        return metaError(400, 100, "Invalid parameter: body is not valid JSON.");
      }

      const to = typeof payload.to === "string" ? payload.to : "";
      const body = typeof payload.text?.body === "string" ? payload.text.body : "";

      if (to === "") return metaError(400, 100, "Invalid parameter: 'to' is required.");

      const messageId = `wamid.MOCK${(messageCounter += 1).toString().padStart(6, "0")}`;
      sent.push({ to, body, messageId });

      return json(200, {
        messaging_product: "whatsapp",
        contacts: [{ input: to, wa_id: to }],
        messages: [{ id: messageId }],
      });
    }

    // POST /{commentId}/replies — Instagram comment reply.
    const replyMatch = /^\/([^/]+)\/replies$/.exec(path);
    if (request.method === "POST" && replyMatch) {
      let message: unknown;
      try {
        message = (JSON.parse(request.body || "{}") as { message?: unknown }).message;
      } catch {
        return metaError(400, 100, "Invalid parameter: body is not valid JSON.");
      }

      if (typeof message !== "string" || message.trim() === "") {
        return metaError(400, 100, "Invalid parameter: 'message' must not be empty.");
      }

      const replyId = corpus.replyToComment(replyMatch[1]!, message, now());
      if (!replyId) return metaError(400, 100, "Unsupported get request: unknown comment id.");

      return json(200, { id: replyId });
    }

    // GET /{accountId}/media — posts with their comments expanded.
    const mediaMatch = /^\/([^/]+)\/media$/.exec(path);
    if (request.method === "GET" && mediaMatch) {
      if (mediaMatch[1] !== accountId) {
        return metaError(403, 200, "Permissions error: unknown Instagram account.");
      }
      return json(200, { data: corpus.mediaAt(now(), sinceOf(url)) });
    }

    // GET /{accountId}/conversations — Instagram DM threads.
    const conversationsMatch = /^\/([^/]+)\/conversations$/.exec(path);
    if (request.method === "GET" && conversationsMatch) {
      if (conversationsMatch[1] !== accountId) {
        return metaError(403, 200, "Permissions error: unknown Instagram account.");
      }

      // The real edge serves Facebook Page threads unless told otherwise, so a
      // connector that forgets `platform=instagram` gets the wrong inbox. Here
      // it gets an error instead, which is the same bug found sooner.
      if (url.searchParams.get("platform") !== "instagram") {
        return metaError(400, 100, "Invalid parameter: platform must be 'instagram'.");
      }

      if (!messagingGranted) {
        // `instagram_manage_messages` is granted separately from the comment
        // scopes, so this is the state a business sits in before that review
        // passes — and the connector must degrade to comments, not fail.
        return metaError(
          403,
          10,
          "(#10) Application does not have permission for this action: instagram_manage_messages",
        );
      }

      return json(200, { data: corpus.conversationsAt(now(), sinceOf(url)) });
    }

    // GET /{accountId}/tags — mentions of the account.
    const tagsMatch = /^\/([^/]+)\/tags$/.exec(path);
    if (request.method === "GET" && tagsMatch) {
      if (tagsMatch[1] !== accountId) {
        return metaError(403, 200, "Permissions error: unknown Instagram account.");
      }
      return json(200, { data: corpus.mentionsAt(now(), sinceOf(url)) });
    }

    // GET /{accountId} — the account itself.
    const accountMatch = /^\/([^/]+)$/.exec(path);
    if (request.method === "GET" && accountMatch) {
      if (accountMatch[1] !== accountId) {
        return metaError(403, 200, "Permissions error: unknown Instagram account.");
      }
      return json(200, { id: accountId, username, name: "Kahve Molası" });
    }

    return metaError(404, 803, `Unknown endpoint: ${request.method} ${path}`);
  }

  /** Meta takes `since` as Unix seconds; honouring it is what makes sync incremental. */
  function sinceOf(url: URL): Date | null {
    const raw = url.searchParams.get("since");
    if (!raw) return null;
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? new Date(seconds * 1_000) : null;
  }

  return {
    handle,
    throttleOnce(retryAfterSeconds = 30) {
      throttleNext = { retryAfterSeconds };
    },
    accountId,
    phoneNumberId,
    sent,
    corpus,
    messagingGranted,
  };
}

export type MetaMock = ReturnType<typeof createMetaMock>;
