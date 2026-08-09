import { redirect } from "next/navigation";
import { requireActor } from "@/auth/session";
import { FirstBriefingProgressView } from "@/components/onboarding/first-briefing-progress";
import { Card } from "@/components/ui/card";
import { listLocationsForActor, resolveActiveLocation } from "@/lib/active-location";
import { withTenant } from "@/lib/tenancy";
import { onboardingStatus } from "@/onboarding/first-briefing";

/**
 * The first briefing, being made (W5-14).
 *
 * Where "Explore with sample data" lands, and where the connect flow sends
 * somebody once their first source has pulled a backfill. Both are the same
 * moment — reviews exist, nothing has read them yet — and the point of this
 * screen is that the next thing a new customer sees is the Action Digest rather
 * than an empty dashboard and an instruction to come back next week.
 *
 * Inside the app shell deliberately. A full-screen takeover would hide the
 * navigation at exactly the moment somebody wants to know what else is here,
 * and the "skip" button is then a real escape rather than the only way out.
 */
export default async function WelcomePage() {
  const actor = await requireActor();

  const { locationId, status } = await withTenant(
    { organizationId: actor.organizationId, userId: actor.userId },
    async (tx) => {
      const locations = await listLocationsForActor(tx, actor);
      const active = resolveActiveLocation(locations, null);
      if (!active) return { locationId: null, status: null };

      return {
        locationId: active.id,
        status: await onboardingStatus(tx, actor.organizationId, active.id),
      };
    },
  );

  // Nothing to brief on and nowhere to put a progress bar. Branches is where
  // somebody in this position actually needs to be.
  if (!locationId || !status) redirect("/locations");

  // Already has one. Landing on a progress screen for work that finished last
  // week would be a loading state for nothing.
  if (status.digestId && status.analysed >= status.analysable) {
    redirect(`/weekly-plan/${status.digestId}`);
  }

  return (
    <Card>
      <FirstBriefingProgressView
        locationId={locationId}
        initial={{
          analysable: status.analysable,
          analysed: status.analysed,
          digestId: status.digestId,
          finished: false,
          empty: status.analysable === 0 && status.reviews === 0,
          // So the first paint is already the right one: without it the screen
          // renders a 0/0 bar for one frame before the first poll corrects it,
          // which is the state A22-B1 is about (A22-B1).
          awaitingSync: status.awaitingSync,
        }}
      />
    </Card>
  );
}
