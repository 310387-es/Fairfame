import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { getAdminDb, schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { provisionTrialSubscription } from "../lib/provisioning.ts";
import { getEmailTransport } from "../messaging/email.ts";
import { renderInvitationEmail, renderPasswordResetEmail } from "../messaging/templates.ts";
import { dashboardBaseUrl } from "../lib/urls.ts";
import { DEFAULT_LOCALE, LOCALES, type Locale } from "../i18n/config.ts";
import { resolveActiveOrganization, rememberActiveOrganization } from "./active-organization.ts";
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

/**
 * How long a password-reset link is good for (W1.9b).
 *
 * One number, used by the config *and* by the email that states it, so the
 * sentence a reader is shown cannot drift from what the token actually does.
 */
const RESET_TOKEN_MINUTES = 60;

/** "tr" | "en", or the default. The organization's column is free text. */
function localeOf(value: string | null | undefined): Locale {
  return (LOCALES as readonly string[]).includes(value ?? "") ? (value as Locale) : DEFAULT_LOCALE;
}

/**
 * Role names for the invitation email, which is the one place a role is shown
 * to somebody who is not yet in the product and so cannot read `next-intl`.
 */
const ROLE_LABELS: Record<Locale, Record<string, string>> = {
  tr: { owner: "Sahip", admin: "Yönetici", member: "Üye", client: "Müşteri" },
  en: { owner: "Owner", admin: "Admin", member: "Member", client: "Client" },
};

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,

  database: drizzleAdapter(getAdminDb(), {
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

    /**
     * How long a reset link lives (W1.9b).
     *
     * An hour, which is BetterAuth's default and stated here rather than
     * inherited because the email tells the reader the number — and a default
     * that moved underneath that sentence would make the product lie. Short on
     * purpose: this link is a bearer token for an account, and it arrives in a
     * mailbox that may be shared, forwarded or breached later.
     */
    resetPasswordTokenExpiresIn: RESET_TOKEN_MINUTES * 60,

    /**
     * The way back into an account (W1.9b).
     *
     * **Without this callback the endpoint does not exist.** BetterAuth refuses
     * `request-password-reset` with `RESET_PASSWORD_DISABLED` unless one is
     * given, which is what it was doing: a teammate invited in W1.9 who forgot
     * their password had no route back in short of a hash written into
     * `accounts.password` from a console.
     *
     * BetterAuth owns the parts that must not be got wrong — it answers the
     * same way whether or not the address exists, and does dummy work when it
     * does not, so this endpoint cannot be used to find out who has an account.
     * What is ours is the email.
     */
    async sendResetPassword({ user, url }) {
      const { subject, text, html } = renderPasswordResetEmail({
        // The *user's* language, not an organization's: at this moment they may
        // belong to none, and the person reading it is the one to serve.
        locale: localeOf((user as { locale?: string | null }).locale),
        name: user.name?.trim() || user.email,
        link: url,
        expiresInMinutes: RESET_TOKEN_MINUTES,
      });

      await getEmailTransport().send({ to: user.email, subject, text, html });
    },
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

  databaseHooks: {
    session: {
      create: {
        /**
         * Give every new session its tenant (W1.1).
         *
         * The organization plugin sets `activeOrganizationId` only inside
         * `setActive`, which nothing calls on sign-in — so without this hook
         * every returning session started with a null active organization and
         * the app shell bounced it to `/create-organization`. See
         * `src/auth/active-organization.ts` for how the answer is chosen and
         * why a remembered organization is re-checked against membership.
         *
         * A failure here degrades to the old behaviour — the picker on
         * `/create-organization` — which is a worse first screen but a screen.
         * Throwing would fail the sign-in itself.
         */
        before: async (session) => {
          try {
            const activeOrganizationId = await resolveActiveOrganization(session.userId);
            if (!activeOrganizationId) return;

            return { data: { ...session, activeOrganizationId } };
          } catch (error) {
            childLogger({ module: "auth/session-hooks" }).error(
              { userId: session.userId, err: error },
              "Failed to resolve active organization for a new session",
            );
            return;
          }
        },
      },
      update: {
        /**
         * Remember where somebody switched to, so the next sign-in opens there.
         *
         * Here rather than in each caller of `setActiveOrganization`: this hook
         * is the one place every switch passes through — the create-organization
         * form, the user menu, the agency console — so a path added later
         * records itself. `rememberActiveOrganization` makes the write
         * conditional, which is what keeps the daily session refresh (same hook,
         * unchanged value) from being a write.
         */
        after: async (session) => {
          const updated = session as { userId?: string; activeOrganizationId?: string | null };
          if (!updated?.userId || !updated.activeOrganizationId) return;

          await rememberActiveOrganization(updated.userId, updated.activeOrganizationId);
        },
      },
    },
  },

  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "owner",
      // Entitlements govern the real ceiling (max_team_members, max_locations);
      // this is only a backstop against runaway organization creation.
      organizationLimit: 20,
      /**
       * How long an invitation stays good (W1.9).
       *
       * Seven days rather than BetterAuth's 48 hours: this is sent to somebody
       * who may be on holiday, and a link that dies over a long weekend turns
       * "join my team" into a support conversation. Short enough that a stale
       * invitation to a person who has left is not a standing door.
       */
      invitationExpiresIn: 60 * 60 * 24 * 7,

      /**
       * The email that makes a team a team (W1.9).
       *
       * Thrown rather than swallowed on failure: BetterAuth surfaces it, so the
       * inviter is told the invitation did not go out. The alternative — a row
       * in the database and silence in the inbox — is the worst of both, and it
       * is exactly the failure mode the audit found everywhere else.
       */
      async sendInvitationEmail(data) {
        // The plugin's `organization` type does not carry our additional
        // fields, so the locale is read from the row rather than cast onto it.
        const organizationLocale = localeOf(
          (data.organization as { locale?: string | null }).locale,
        );

        const { subject, text, html } = renderInvitationEmail({
          locale: organizationLocale,
          inviterName: data.inviter.user.name || data.inviter.user.email,
          businessName: data.organization.name,
          roleLabel: ROLE_LABELS[organizationLocale][data.role] ?? data.role,
          link: `${dashboardBaseUrl()}/invite/${data.id}`,
          expiresAt: data.invitation.expiresAt,
        });

        await getEmailTransport().send({ to: data.email, subject, text, html });
      },

      organizationHooks: {
        // Every new organization starts on a 14-day trial with top-tier
        // entitlements. Failing here would leave an organization with no
        // subscription at all, which resolves to the Starter floor — degraded
        // but not broken — so log loudly rather than failing the signup.
        afterCreateOrganization: async ({ organization }) => {
          try {
            await provisionTrialSubscription(organization.id);
          } catch (error) {
            childLogger({ module: "auth/provisioning" }).error(
              { organizationId: organization.id, err: error },
              "Failed to provision trial subscription",
            );
          }
        },
      },
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
