/**
 * How a review source is doing, in one word a business can act on (W4.2).
 *
 * Pure and db-free: it takes the plain columns off a `connections` row plus the
 * provider's polling policy, and returns a state. That makes every judgement
 * below testable against a fixed clock, which matters because most of them are
 * about *time* and every one of them is the kind of thing that silently starts
 * lying when a threshold is off.
 *
 * ## The states, and why these five
 *
 * Each one is a **different act**, which is the test for whether a state earns
 * its place. Two states a business would respond to identically are one state
 * with extra reading.
 *
 *   - `healthy` — nothing to do.
 *   - `setup` — you started connecting this and did not finish. You finish it.
 *   - `reconnect` — we cannot renew the credentials. Only you can, by signing
 *     in again. Nothing we do in the background will fix it.
 *   - `limited` — the platform is throttling us. Nobody does anything; it
 *     resolves itself. Shown so that "why is it behind" has an answer that is
 *     not "it is broken".
 *   - `failing` — it is erroring for some other reason. Worth telling us about.
 *   - `stale` — no error, but it has not synced in far longer than it should
 *     have. The state that catches the failure nobody notices: a worker that
 *     stopped, a schedule that never fired. `status` still says `active` and
 *     `last_error` is still null, so every other signal on the row says fine.
 *
 * ## "Token expiring" is not one of them, deliberately
 *
 * `docs/remediation-plan.md` asks for a "Token expiring" badge, and that is the
 * wrong shape for how OAuth actually works here. An **access** token is
 * *supposed* to expire — Google's lasts an hour — and `getFreshAccessToken()`
 * renews it on the way to every call. A badge driven off `expiresAt` would be
 * lit almost permanently on a perfectly healthy connection, which is the fastest
 * way to teach somebody to ignore a badge.
 *
 * What actually breaks is having **nothing to renew with**: no refresh token,
 * and an access token at or past its expiry. That is unrecoverable without a
 * human, so it is `reconnect` — named for the act rather than for the mechanism.
 */

export type ConnectionHealth = "healthy" | "setup" | "reconnect" | "limited" | "failing" | "stale";

/**
 * How far past its own polling interval a connection may drift before it is
 * `stale`.
 *
 * Generous on purpose. A connection is only scanned when a worker runs, backoff
 * legitimately pushes `next_sync_at` hours out, and a provider that is quiet is
 * not a provider that is broken. The number that matters is the one where a
 * *person* would say "that cannot be right" — six missed intervals, floored at
 * a day so a fast-polling source is not called stale after half an hour.
 */
export const STALE_INTERVALS = 6;
export const MIN_STALE_MS = 24 * 60 * 60 * 1_000;

/**
 * The error kinds we persist and recognise. Anything else — including a value
 * written by a future version and read by this one — falls through to
 * `failing`, which is the safe direction: a connection that is erroring is
 * reported as erroring, just less specifically.
 */
export type ConnectionErrorKind = "rate_limit" | "auth" | "access" | "other";

export type HealthInput = {
  status: "pending" | "active" | "error" | "disconnected";
  lastSyncedAt: Date | null;
  failureCount: number;
  lastErrorKind: string | null;
  /** True when credentials exist but nothing can renew them — see above. */
  needsReauth: boolean;
  /** The provider's `minSyncIntervalMs`. A push source passes null. */
  syncIntervalMs: number | null;
};

export function connectionHealth(input: HealthInput, now = new Date()): ConnectionHealth {
  // A connection somebody disconnected is not unhealthy, it is gone; callers
  // filter those out before they reach a card. Kept here so the function is
  // total rather than throwing on a value the type allows.
  if (input.status === "disconnected") return "healthy";
  if (input.status === "pending") return "setup";

  if (input.status === "error") {
    // Rate limiting is checked *before* the failure count, because a busy
    // source can rack up a dozen 429s in a morning and none of them mean the
    // connection is broken. Reporting that as "failing" would send somebody to
    // reconnect a source that is working exactly as designed.
    if (input.lastErrorKind === "rate_limit") return "limited";
    if (input.lastErrorKind === "auth") return "reconnect";
    return "failing";
  }

  // `active`, and the credentials cannot be renewed. Nothing has failed *yet* —
  // the next sync is the one that will — which is the entire value of saying so
  // now rather than after it does.
  if (input.needsReauth) return "reconnect";

  if (input.syncIntervalMs !== null) {
    const allowed = Math.max(input.syncIntervalMs * STALE_INTERVALS, MIN_STALE_MS);
    // A connection that has never synced at all is not stale — it is new, and
    // `pending`/`setup` already covers the case where it never will be.
    if (input.lastSyncedAt !== null && now.getTime() - input.lastSyncedAt.getTime() > allowed) {
      return "stale";
    }
  }

  return "healthy";
}

/**
 * Whether a state is one somebody should be looking at, which is what drives
 * the coverage bar's warning and the ordering of the cards.
 *
 * `limited` is deliberately **not** here: it resolves itself, and a screen that
 * cries for attention over a rate limit is one whose attention signal stops
 * meaning anything.
 */
export function needsAttention(health: ConnectionHealth): boolean {
  return health === "setup" || health === "reconnect" || health === "failing" || health === "stale";
}

/** The kind to persist for an error, from the error itself. */
export function errorKindOf(error: unknown): ConnectionErrorKind {
  const name = error instanceof Error ? error.name : "";

  if (name === "RateLimitError") return "rate_limit";
  if (name === "OAuthError") return "auth";
  // Google's "the caller does not have permission" — the API access request has
  // not been approved, or the account does not manage this location. Neither is
  // fixed by reconnecting, so it must not be reported as `reconnect`.
  if (name === "GoogleAccessError") return "access";

  return "other";
}
