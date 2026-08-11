/**
 * Next.js startup hook.
 *
 * Runs once per server process, before the first request. Two things are
 * installed here, and the order matters.
 *
 * The İYS gateway is installed for the same reason the worker installs it
 * before consuming: a request that sends a commercial message must never reach
 * an unconfigured gate and get a refusal that looks like a bug. It also means a
 * deployment with no gateway says so in the boot log rather than at the first
 * refused message.
 *
 * Sentry is installed here because **nothing else imports its config files**.
 * `sentry.server.config.ts` and `sentry.edge.config.ts` are inert on their own;
 * the Sentry wizard normally adds these imports and skipped this file because
 * `register()` already existed, which left both configs written, committed, and
 * never once executed.
 */
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  /**
   * Edge first, and above the guard below — not merely beside it.
   *
   * The guard exists because node-only modules (pg, ioredis, node:crypto) are
   * unavailable in the edge runtime, so everything after it is Node-only by
   * construction. Appending the Sentry import underneath it — the obvious
   * place, and where a generated patch would land — means the edge runtime
   * returns before reaching it and edge errors are never reported. Nothing
   * fails; the reports simply do not arrive, which is the hardest kind of gap
   * to notice.
   */
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config.ts");
    return;
  }

  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  await import("../sentry.server.config.ts");

  const { installIysGateway } = await import("./compliance/iys-gateway.ts");
  installIysGateway();
}

/**
 * Errors thrown inside server components, route handlers and middleware.
 *
 * Without this export they are logged by Next and never reach Sentry — the
 * `register()` hook installs the SDK but does not subscribe it to the request
 * lifecycle. Most of this app's server-side work happens in exactly these
 * places, so omitting it would leave the majority of real failures uncaptured
 * while the dashboard looked healthy.
 */
export const onRequestError = Sentry.captureRequestError;
