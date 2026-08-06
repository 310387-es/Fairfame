import { Sparkles } from "lucide-react";
import { eq } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { requireActor } from "@/auth/session";
import { roleAtLeast } from "@/auth/permissions";
import { AvailableSource } from "@/components/connections/available-source";
import { ConnectedSourceCard } from "@/components/connections/connected-source";
import { CoverageBar } from "@/components/connections/coverage-bar";
import { RoadmapSourceCard } from "@/components/connections/roadmap-source";
import { Eyebrow } from "@/components/ds/eyebrow";
import { SectionCard } from "@/components/ds/section-card";
import { PageHeader } from "@/components/shell/page-header";
import { SectionTabs } from "@/components/shell/section-tabs";
import { loadConnectionFacts } from "@/connections/facts";
import { schema } from "@/db/client";
import { withTenant } from "@/lib/tenancy";

/**
 * Connections: is every source we could be reading actually being read? (W4.2)
 *
 * ## Why this is its own screen
 *
 * Sources have always been attached to branches, and they still are — a Google
 * connection is per location because a Business Profile listing is. But the
 * Locations screen answers "what feeds this branch", and nobody ever had a
 * screen answering the other question: *is Google working*. On a nine-branch
 * business that question needed nine cards scrolled and compared, and the
 * answer to "why have we had no reviews this week" was somewhere in them.
 *
 * So: one card per provider, with the branches inside it, and the worst branch
 * setting the card's health — a chain with Google broken on one of five does
 * not have a working Google connection.
 *
 * ## Three groups, and the third one is the point
 *
 * **Connected** is what is running. **Available** is what this deployment could
 * connect today. **Roadmap** is what we have not built — and it is on the
 * screen because a Turkish café gets more reviews on Yemeksepeti than on
 * Google, and a grid that stops after two cards tells them this product does
 * not know their business exists. Saying "not yet, and here is the button that
 * tells us you want it" is a better answer than silence, and the presses are
 * the only real evidence we will get about what to build next.
 */
export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ dev?: string }>;
}) {
  const [t, actor, params] = await Promise.all([
    getTranslations("connections"),
    requireActor(),
    searchParams,
  ]);

  // Both conditions, exactly as `/locations` does it (W1.4): the query string is
  // a convenience for whoever is building, and `NODE_ENV` is the half that
  // cannot be typed into an address bar by a customer who saw it in a recording.
  const includeDevOnly = process.env.NODE_ENV !== "production" && params.dev === "1";

  const [facts, locations] = await Promise.all([
    loadConnectionFacts({
      organizationId: actor.organizationId,
      userId: actor.userId,
      includeDevOnly,
    }),
    withTenant({ organizationId: actor.organizationId, userId: actor.userId }, (tx) =>
      tx
        .select({ id: schema.locations.id, name: schema.locations.name })
        .from(schema.locations)
        .where(eq(schema.locations.organizationId, actor.organizationId))
        .orderBy(schema.locations.name),
    ),
  ]);

  const canManage = roleAtLeast(actor.role, "admin");

  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SectionTabs active="connections" />

      <div className="flex flex-col gap-6">
        <CoverageBar
          connected={facts.coverage.connected}
          total={facts.coverage.total}
          attention={facts.coverage.attention}
        />

        {facts.connected.length > 0 ? (
          <section className="flex flex-col gap-3">
            <Eyebrow>{t("connectedHeading")}</Eyebrow>
            <ul className="grid gap-3 lg:grid-cols-2">
              {facts.connected.map((card) => (
                <li key={card.provider}>
                  <ConnectedSourceCard card={card} canManage={canManage} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {facts.available.length > 0 ? (
          <section className="flex flex-col gap-3">
            <Eyebrow>{t("availableHeading")}</Eyebrow>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {facts.available.map((card) => (
                <li key={card.provider}>
                  <AvailableSource card={card} locations={locations} canManage={canManage} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <SectionCard title={t("roadmapHeading")} icon={Sparkles}>
          <div className="pb-(--card-py)">
            <p className="text-body text-muted-foreground">{t("roadmapIntro")}</p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {facts.roadmap.map((card) => (
                <li key={card.key}>
                  <RoadmapSourceCard card={card} />
                </li>
              ))}
            </ul>
          </div>
        </SectionCard>
      </div>
    </>
  );
}
