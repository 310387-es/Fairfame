/**
 * A shared request pacer.
 *
 * Lives in `lib` rather than in `ai` because the problem is not specific to
 * models: any API with a per-minute ceiling needs the same thing, and the
 * connector sync in Phase 1b will want it too.
 *
 * The subtlety is that concurrency and rate are different limits. Three workers
 * each sleeping between their own calls still produce three times the intended
 * rate — they simply sleep in parallel. This holds one shared cursor for the
 * next available slot, so the aggregate rate is the limit regardless of how
 * many callers there are.
 *
 * Learned the hard way: an unpaced evaluation run against Gemini's free tier
 * (15 requests per minute) failed 38 of 40 cases on quota and still reported
 * that it had passed, because the two cases that survived happened to be right.
 */

export type Pacer = () => Promise<void>;

export type PacerOptions = {
  /** Injected so tests can assert the delays without waiting for them. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected because Date.now() cannot be controlled from a test. */
  now?: () => number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Spaces calls to at most `perMinute`, shared across all callers. */
export function createPacer(perMinute: number, options: PacerOptions = {}): Pacer {
  const sleep = options.sleep ?? defaultSleep;
  const clock = options.now ?? Date.now;
  const intervalMs = Math.ceil(60_000 / Math.max(1, perMinute));

  let nextSlot = 0;

  return async function take(): Promise<void> {
    const now = clock();
    // Claim the slot before awaiting: a concurrent caller must see the cursor
    // already moved, or two workers claim the same slot and the rate doubles.
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + intervalMs;

    if (slot > now) await sleep(slot - now);
  };
}
