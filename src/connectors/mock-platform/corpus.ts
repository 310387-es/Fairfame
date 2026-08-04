import { generateCorpus, type MockReviewPayload } from "../mock-data.ts";

/**
 * The reviews the fake platform is holding, and how they arrive.
 *
 * Two things distinguish this from a fixture file. It is **Google-shaped** —
 * `starRating` as a word, `createTime` in RFC 3339, the full resource `name` —
 * so the real connector's parser is exercised rather than a convenient one. And
 * it **grows**: reviews are dated across a window that extends past "now", so a
 * sync ten minutes later finds content that did not exist before.
 *
 * The drip is the point. A platform that returns the same twenty rows forever
 * proves a connector can read a page; it proves nothing about cursors advancing,
 * dedup holding across runs, or incremental sync stopping where it should. Those
 * only appear when new content shows up behind ones already seen.
 *
 * Deterministic from a seed, so two processes asking the same question get the
 * same answer and a failing test can be re-run.
 */

/** Google spells the rating out. */
const STAR_WORDS = ["STAR_RATING_UNSPECIFIED", "ONE", "TWO", "THREE", "FOUR", "FIVE"] as const;

export type GoogleReview = {
  name: string;
  reviewId: string;
  reviewer: { displayName: string; profilePhotoUrl?: string };
  starRating: string;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment: string; updateTime: string };
};

export type CorpusOptions = {
  accountId: string;
  locationId: string;
  /** How many already existed when the connector first looked. */
  backfill?: number;
  /** How often a new one arrives. */
  dripMs?: number;
  /** Fixes the sequence, so a run can be reproduced. */
  seed?: string;
  /** When the account was "opened" — the oldest review is just after it. */
  startedAt?: Date;
};

const DEFAULTS = {
  backfill: 24,
  // Fast enough that a person watching `pnpm dev` sees something new within a
  // sync cycle or two, slow enough that a test run is not a flood.
  dripMs: 30_000,
  seed: "mock-platform",
};

function toGoogle(
  payload: MockReviewPayload,
  args: { accountId: string; locationId: string },
): GoogleReview {
  const reviewId = payload.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "AbFvOq";

  return {
    name: `accounts/${args.accountId}/locations/${args.locationId}/reviews/${reviewId}`,
    reviewId,
    reviewer: { displayName: payload.author.name },
    starRating: STAR_WORDS[payload.rating] ?? "STAR_RATING_UNSPECIFIED",
    // Google omits the field entirely for a star-only review rather than
    // sending an empty string, and the connector has to cope with that.
    ...(payload.comment.trim() === "" ? {} : { comment: payload.comment }),
    createTime: payload.createdAt,
    updateTime: payload.ownerReply?.repliedAt ?? payload.createdAt,
    ...(payload.ownerReply
      ? {
          reviewReply: {
            comment: payload.ownerReply.text,
            updateTime: payload.ownerReply.repliedAt,
          },
        }
      : {}),
  };
}

/**
 * A location's review history, as a function of the clock.
 *
 * Reviews are generated once and dated deterministically; which of them are
 * *visible* depends on when you ask. That is what makes the drip free of hidden
 * state — two workers polling the same fake location see the same thing at the
 * same moment, and rewinding the clock rewinds the platform.
 */
export function createLocationCorpus(options: CorpusOptions) {
  const accountId = options.accountId;
  const locationId = options.locationId;
  const backfill = options.backfill ?? DEFAULTS.backfill;
  const dripMs = options.dripMs ?? DEFAULTS.dripMs;
  const seed = options.seed ?? DEFAULTS.seed;
  const startedAt = options.startedAt ?? new Date();

  // Generated well past the backfill so the drip has somewhere to draw from for
  // days without repeating itself.
  const pool = generateCorpus({
    locationId,
    count: backfill + 500,
    until: startedAt,
    seed,
    batchTag: "platform",
  });

  const history = pool
    .slice(0, backfill)
    .map((payload) => toGoogle(payload, { accountId, locationId }));

  const upcoming = pool.slice(backfill).map((payload, index) => {
    // Each future review is stamped at the moment it becomes visible, so its
    // `createTime` and its arrival agree — a platform that returned a review
    // dated before it appeared would break incremental sync in a way no real
    // one does.
    const at = new Date(startedAt.getTime() + (index + 1) * dripMs);
    return toGoogle(
      { ...payload, createdAt: at.toISOString(), ownerReply: undefined },
      { accountId, locationId },
    );
  });

  return {
    /** Every review visible at `now`, newest update first — Google's order. */
    reviewsAt(now: Date): GoogleReview[] {
      const arrived = upcoming.filter((review) => new Date(review.createTime) <= now);
      return [...history, ...arrived].sort(
        (left, right) => Date.parse(right.updateTime) - Date.parse(left.updateTime),
      );
    },

    /** When the next unseen review will appear. Used by the runner's log line. */
    nextArrivalAfter(now: Date): Date | null {
      const next = upcoming.find((review) => new Date(review.createTime) > now);
      return next ? new Date(next.createTime) : null;
    },

    /** Records an owner reply, exactly as a PUT to the real endpoint would. */
    reply(reviewId: string, comment: string, now: Date): GoogleReview | null {
      const target =
        history.find((review) => review.reviewId === reviewId) ??
        upcoming.find((review) => review.reviewId === reviewId);
      if (!target) return null;

      target.reviewReply = { comment, updateTime: now.toISOString() };
      // Replying bumps the update time, which is what makes the reply come back
      // on the next incremental sync — the behaviour a connector must not be
      // surprised by.
      target.updateTime = now.toISOString();
      return target;
    },
  };
}

export type LocationCorpus = ReturnType<typeof createLocationCorpus>;
