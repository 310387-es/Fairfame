import { runDueBroadcasts } from "../../broadcasts/pipeline.ts";
import { childLogger } from "../../lib/logger.ts";

/**
 * The broadcast sweep (P4-T4).
 *
 * A fan-out and nothing else: `runDueBroadcasts` finds what is due across every
 * tenant and `runBroadcast` decides everything about each one — the claim, the
 * audience, the gate, the metering. Keeping this file empty of judgement is
 * what lets "send now" from the screen and "send because it is Thursday" be the
 * same code path, which is the only way the second one is ever tested.
 *
 * **This module must not import anything that reaches a request API.** It runs
 * under `pnpm worker` — plain Node, no Next runtime — and `next/headers`
 * reaching a worker through an innocent-looking helper is the failure P3-T5
 * shipped: every test passed and only the process nobody watches crashed, at
 * startup.
 */

const log = childLogger({ module: "jobs/broadcasts" });

export type BroadcastSweepResult = {
  broadcasts: number;
  sent: number;
  refused: number;
  failed: number;
};

export async function runBroadcastSweep(now = new Date()): Promise<BroadcastSweepResult> {
  const outcomes = await runDueBroadcasts(now);

  const result = outcomes.reduce<BroadcastSweepResult>(
    (total, outcome) => ({
      broadcasts: total.broadcasts + 1,
      sent: total.sent + outcome.sent,
      refused: total.refused + outcome.refused,
      failed: total.failed + outcome.failed,
    }),
    { broadcasts: 0, sent: 0, refused: 0, failed: 0 },
  );

  // Silent when there is nothing to do, which is almost every minute. A log
  // line per empty sweep would bury the ones that matter.
  if (result.broadcasts > 0) log.info(result, "Broadcast sweep finished");

  return result;
}
