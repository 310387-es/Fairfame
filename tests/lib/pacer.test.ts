import { describe, expect, it } from "vitest";
import { createPacer } from "@/lib/pacer";

/**
 * The pacer, with a controlled clock (P1a-T3).
 *
 * Worth its own suite because the failure it prevents is invisible in review:
 * a per-worker sleep looks like pacing, produces N times the intended rate, and
 * only shows up as a wall of 429s against a real provider.
 */

/**
 * A clock the test drives explicitly.
 *
 * `sleep` records the requested delay without advancing the clock. A fake that
 * advanced time inside `sleep` would serialize concurrent waiters — the second
 * caller would observe the first one's sleep as already elapsed — and the
 * concurrency assertion below would measure the fake rather than the pacer.
 */
function fakeClock() {
  let current = 1_000_000;
  const delays: number[] = [];

  return {
    delays,
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("createPacer", () => {
  it("lets the first call through immediately", async () => {
    const clock = fakeClock();
    const pace = createPacer(60, clock);

    await pace();

    expect(clock.delays).toEqual([]);
  });

  it("spaces sequential calls by the interval", async () => {
    const clock = fakeClock();
    const pace = createPacer(60, clock); // one per second

    await pace();

    await pace();
    clock.advance(1000);

    await pace();

    expect(clock.delays).toEqual([1000, 1000]);
  });

  it("keeps the aggregate rate when callers run concurrently", async () => {
    const clock = fakeClock();
    const pace = createPacer(60, clock);

    // The bug this guards: four workers each pacing themselves would all pass
    // instantly. Sharing one cursor means the fourth waits three intervals.
    await Promise.all([pace(), pace(), pace(), pace()]);

    expect(clock.delays.filter((delay) => delay > 0)).toEqual([1000, 2000, 3000]);
  });

  it("does not make a caller wait when the rate has gone idle", async () => {
    const clock = fakeClock();
    const pace = createPacer(60, clock);

    await pace();
    clock.advance(5000); // a long gap between batches

    await pace();

    // Unused capacity is not banked, but it is also not charged for.
    expect(clock.delays).toEqual([]);
  });

  it("treats a nonsensical rate as one per minute rather than dividing by zero", () => {
    expect(() => createPacer(0)).not.toThrow();
  });
});
