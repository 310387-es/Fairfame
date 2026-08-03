/**
 * Next.js startup hook.
 *
 * Runs once per server process, before the first request. The İYS gateway is
 * installed here for the same reason the worker installs it before consuming:
 * a request that sends a commercial message must never reach an unconfigured
 * gate and get a refusal that looks like a bug.
 *
 * It also means a deployment with no gateway says so in the boot log rather
 * than at the first refused message.
 */
export async function register(): Promise<void> {
  // Guarded: the hook also runs in the edge runtime, where node-only modules
  // (pg, ioredis, node:crypto) are unavailable.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installIysGateway } = await import("./compliance/iys-gateway.ts");
  installIysGateway();
}
