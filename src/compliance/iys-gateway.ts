import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { setIysGateway, type IysGateway, type IysVerdict } from "./gate.ts";

/**
 * İYS gateway adapters (P1b-T5).
 *
 * The registry itself is reached through a BSP (a licensed gateway), and which
 * one depends on the WhatsApp/SMS provider a deployment ends up with. So this
 * is a seam with concrete implementations behind an env flag, and the real one
 * is wired at go-live without touching the gate.
 *
 * **The default is `none`, which refuses.** A deployment that has not chosen a
 * gateway cannot send commercial messages — see the reasoning in ./gate.ts.
 * That is the correct behaviour, and it is why this module ships with no
 * implementation that could be mistaken for a real one.
 */

const log = childLogger({ module: "compliance/iys-gateway" });

/**
 * Trusts our own consent records. **Never valid in production.**
 *
 * İYS is the system of record: a permission we hold but the registry does not
 * is a permission we may not act on. This adapter exists so the send path can
 * be exercised end to end in development, and it refuses outright when
 * `NODE_ENV` is production — a guard rather than a comment, because "we will
 * remember to change the env var before launch" is not a control.
 */
export function createLocalGateway(nodeEnv: string): IysGateway {
  return {
    name: "local",
    async check(): Promise<IysVerdict> {
      if (nodeEnv === "production") {
        log.error(
          "IYS_GATEWAY=local reached production. Refusing: İYS is the system of record and a " +
            "local consent record is not a substitute for it.",
        );
        return "not_configured";
      }

      // The gate has already confirmed a local consent record exists and that
      // the contact has not opted out; there is nothing further this adapter
      // can honestly add.
      return "allowed";
    },
  };
}

/**
 * Installs the gateway this environment selects.
 *
 * Called once at worker and app startup. Returns the adapter's name, or null
 * when none is configured — the caller logs it so a deployment that cannot send
 * says so loudly at boot rather than at the first refused message.
 */
export function installIysGateway(): string | null {
  const env = getEnv();

  switch (env.IYS_GATEWAY) {
    case "local": {
      const gateway = createLocalGateway(env.NODE_ENV);
      setIysGateway(gateway);
      log.warn(
        { gateway: gateway.name },
        "İYS gateway is `local`: it trusts our own consent records and is not the registry",
      );
      return gateway.name;
    }

    case "none":
    default:
      setIysGateway(null);
      log.info("No İYS gateway configured; commercial sends will be refused");
      return null;
  }
}
