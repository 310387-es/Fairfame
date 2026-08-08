import { getAdminDb } from "../../db/client.ts";
import { childLogger } from "../../lib/logger.ts";
import { locationsWithAutoReply, runAutoReply, type AutoReplyOutcome } from "../../replies/auto.ts";

/**
 * The auto-reply sweep (W5-6).
 *
 * One job rather than the usual sweep-and-fan-out pair, and that is a decision
 * about *volume*: the fan-out shape exists because a sync or an analysis can
 * take minutes per tenant, while this posts at most a couple of dozen canned
 * replies per location and only for locations that have switched the rule on —
 * which, given it is off by default, is a short list.
 *
 * Cross-tenant read to find them, like every other sweep: a scheduler has no
 * session. It reads location ids, an organization id and two settings; the work
 * itself happens inside each tenant's own `withTenant`.
 */

const log = childLogger({ module: "jobs/auto-reply" });

export type AutoReplySweepResult = AutoReplyOutcome & { locations: number };

export async function runAutoReplySweep(now = new Date()): Promise<AutoReplySweepResult> {
  const rules = await locationsWithAutoReply(getAdminDb());
  const result: AutoReplySweepResult = {
    locations: rules.length,
    posted: 0,
    failed: 0,
    unpostable: 0,
  };

  for (const rule of rules) {
    const outcome = await runAutoReply(rule, now);
    result.posted += outcome.posted;
    result.failed += outcome.failed;
    result.unpostable += outcome.unpostable;
  }

  if (result.posted > 0 || result.failed > 0) log.info(result, "Auto-reply sweep");
  return result;
}
