import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { getAdminDb, schema } from "../db/client.ts";
import { getEnv } from "../lib/env.ts";
import { childLogger } from "../lib/logger.ts";
import { provisionTrialSubscription } from "../lib/provisioning.ts";
import { getEmailTransport } from "../messaging/email.ts";
import {
  renderInvitationEmail,
  renderPasswordResetEmail,
  renderVerifyEmailEmail,
} from "../messaging/templates.ts";
import { isGoogleAuthConfigured } from "./social.ts";
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

/**
 * How long an address-verification link is good for.
 *
 * A day rather than the reset link's hour, and the difference is what the two
 * links *are*. A reset link is a bearer token for an account and a short life
 * is a security property. A verification link proves an address receives mail;
 * it grants nothing on its own, and the person following it may be doing so
 * from the phone they left in another room. Stated here rather than inherited
 * for the same reason as the reset window: the email prints the number.
 */
const VERIFY_TOKEN_HOURS = 24;

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

  /**
   * Signing in with Google, when this deployment has a client for it.
   *
   * **Registered conditionally, and that is the whole failure mode being
   * avoided.** BetterAuth throws `CLIENT_ID_AND_SECRET_REQUIRED` from inside
   * the authorization-URL builder, which is to say *after* somebody has pressed
   * the button — a 500 on the front door of a product nobody has signed into
   * yet. An empty `socialProviders` has no such endpoint to press, and the
   * screen does not draw a button for a provider that is not there.
   *
   * **No `scope` is set on purpose.** BetterAuth's Google provider already asks
   * for exactly `email profile openid`, which is all a login needs; adding to
   * that list is how a sign-in button quietly starts asking a café owner for
   * their calendar. The Business Profile connector's scopes belong to the
   * *other* client — see `GOOGLE_AUTH_CLIENT_ID` in `src/lib/env.ts`.
   *
   * Google's profile carries `email_verified`, and BetterAuth maps it onto
   * `users.email_verified` at sign-up. That is what makes an OAuth arrival a
   * verified sender under `src/auth/verification.ts` with nothing else to do.
   */
  ...(isGoogleAuthConfigured()
    ? {
        socialProviders: {
          google: {
            clientId: env.GOOGLE_AUTH_CLIENT_ID as string,
            clientSecret: env.GOOGLE_AUTH_CLIENT_SECRET as string,
          },
        },
      }
    : {}),

  account: {
    /**
     * One person, one row, however they came in.
     *
     * Without this a customer who signed up with a password in March and
     * pressed "Continue with Google" in April would be refused outright —
     * `users.email` is unique, so the second identity has nowhere to go. They
     * would read that as the product having lost their account.
     *
     * `google` is trusted because Google states whether it verified the address
     * (`email_verified`), which is the only claim that makes linking safe: an
     * unverified assertion of an address is just a typed-in string, and
     * trusting one would let anybody claim an existing account by naming its
     * email at an identity provider that never checks.
     *
     * **`requireLocalEmailVerified` is left at its default of `true`**, and it
     * is worth saying why the looser setting is tempting. Linking also asks the
     * *local* row to have proved its address — so a password account that never
     * clicked the verification email is not linked into, and Google sign-in on
     * that address is refused rather than merged. That is deliberate on
     * BetterAuth's part and correct here: the alternative hands the real
     * owner's Google identity to whoever registered their address first. The
     * way out is the verification email this config now sends, not a weaker
     * gate. (BetterAuth has the option marked deprecated and the behaviour
     * becoming unconditional, so setting it would buy a release at most.)
     */
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },

  /**
   * Proving the address, without standing in the doorway (P5-T4).
   *
   * `requireEmailVerification` stays **false**, deliberately and in tension
   * with the usual advice: the product's stated target is ten minutes from
   * signing up to seeing something worth having, and a verification wall spends
   * the first of those ten on a round trip to a mail client. What verification
   * gates instead is the narrower thing that actually needs it — sending mail
   * to *other people* — which `src/auth/verification.ts` enforces at the send
   * seam. Signing in, connecting a source, reading the sample workspace and
   * running analysis are all open to an unverified account, because none of
   * them can reach a stranger's inbox.
   *
   * `sendOnSignUp` is explicit rather than left to follow
   * `requireEmailVerification`: with that flag false the default is to send
   * *nothing*, so the address could never be proved and every outbound send in
   * the product would be permanently refused.
   *
   * OAuth arrivals get none of this. They are already verified, and mailing
   * somebody a link to confirm what Google just confirmed is noise.
   */
  emailVerification: {
    sendOnSignUp: true,
    expiresIn: VERIFY_TOKEN_HOURS * 60 * 60,
    async sendVerificationEmail({ user, url }) {
      const { subject, text, html } = renderVerifyEmailEmail({
        locale: localeOf((user as { locale?: string | null }).locale),
        name: user.name?.trim() || user.email,
        link: url,
        expiresInHours: VERIFY_TOKEN_HOURS,
      });

      await getEmailTransport().send({ to: user.email, subject, text, html });
    },
  },

  emailAndPassword: {
    enabled: true,
    // Verification is sent but not demanded — see `emailVerification` above,
    // which explains why the wall is at the send seam and not at the door.
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
      /**
       * Whether they ticked the marketing box on the sign-up form (P5-T2).
       *
       * **`input: true` on purpose, and it is the one additional field where
       * that is right.** `lastActiveOrganizationId` is explicitly *not* an
       * additional field because it is ours to write and a signup request must
       * not be able to set it. This is the mirror image: it is a statement the
       * person is making about themselves, so the request is exactly where it
       * should come from. The worst a forged `true` achieves is opting its own
       * sender into email.
       *
       * The **timestamp** is not here, and that is the part that matters. When
       * a consent was given is evidence, not a preference — see the create hook
       * below, which stamps it server-side from the clock. `iys_uploaded_via`
       * elsewhere in the product records provenance for the same reason: a
       * consent record whose date the subject could have chosen is not a record.
       *
       * Absent means false, which is what an OAuth arrival is. There is no form
       * on that path, so there is nothing to infer from, and inferring anything
       * is how a product ends up mailing people who never asked.
       */
      marketingEmailConsent: {
        type: "boolean",
        required: false,
        input: true,
      },
      /**
       * When they agreed — declared so the adapter will persist it, and
       * `input: false` so only we can.
       *
       * It has to be declared at all: the Drizzle adapter writes the fields it
       * knows about, so a timestamp the create hook adds to a payload nobody
       * declared is silently dropped — and the `users_marketing_consent_dated`
       * constraint would then refuse the insert, which is a failed sign-up for
       * everybody who ticks the box. Declaring it with `input: false` is
       * BetterAuth's own way of saying "ours to write", which is exactly the
       * distinction the schema comment draws.
       */
      marketingEmailConsentAt: {
        type: "date",
        required: false,
        input: false,
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh at most daily
  },

  databaseHooks: {
    user: {
      create: {
        /**
         * Date the consent, from the clock rather than from the request (P5-T2).
         *
         * The tick arrives with the signup because it is the person's own
         * statement; *when* they made it is the evidence behind that statement,
         * and evidence a client can supply is not evidence. Same posture as
         * `consents.granted_at` on the customer side of the product, where the
         * distinction is enforceable law rather than good manners.
         *
         * Only ever set, never cleared here: a signup cannot un-consent, and
         * withdrawing later is a different act on a different screen that has
         * to leave its own trail.
         */
        before: async (user) => {
          const consented = (user as { marketingEmailConsent?: boolean }).marketingEmailConsent;
          if (consented !== true) return;

          return { data: { ...user, marketingEmailConsentAt: new Date() } };
        },
      },
    },

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
