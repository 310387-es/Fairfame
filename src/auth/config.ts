import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { adminDb, schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { ac, roles } from "./permissions.ts";

/**
 * BetterAuth — authentication, organizations and roles, on our own Postgres.
 *
 * Why adminDb and not appDb
 * -------------------------
 * BetterAuth runs before a tenant context can exist. Login looks up an account
 * by email with no organization in hand, and "which organizations do I belong
 * to?" is by definition a cross-organization question. Running it on the
 * RLS-bound role would return nothing and break sign-in.
 *
 * So auth uses the owner connection. Tenant isolation is not weakened by this:
 * BetterAuth's queries are keyed on the session's own user, and every piece of
 * application data still goes through `withTenant()` on the RLS-bound role.
 * The rule stands — application code never queries adminDb directly.
 */

const env = getEnv();

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(adminDb, {
    provider: "pg",
    // Our tables are plural and `member` is called `memberships`, so the
    // mapping is explicit rather than usePlural.
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
      organization: schema.organizations,
      member: schema.memberships,
      invitation: schema.invitations,
    },
  }),

  advanced: {
    database: {
      // Our primary keys are native uuid with a gen_random_uuid() default;
      // this tells BetterAuth to let Postgres generate them.
      generateId: "uuid",
    },
  },

  emailAndPassword: {
    enabled: true,
    // Phase 0 has no mail transport yet. Turn this on with the T-later email
    // work — leaving it off must be a deliberate, visible choice.
    requireEmailVerification: false,
    minPasswordLength: 12,
  },

  user: {
    additionalFields: {
      locale: {
        type: "string",
        required: false,
        input: true,
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh at most daily
  },

  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "owner",
      // Entitlements govern the real ceiling (max_team_members, max_locations);
      // this is only a backstop against runaway organization creation.
      organizationLimit: 20,
      schema: {
        organization: {
          additionalFields: {
            locale: { type: "string", required: false, input: true },
            currency: { type: "string", required: false, input: true },
          },
        },
      },
    }),
  ],
});

export type Auth = typeof auth;
export type Session = Auth["$Infer"]["Session"];
