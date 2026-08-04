import { inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabasePools, getAdminDb, schema } from "@/db/client";
import { renderTemplate } from "@/replies/template-vars";
import {
  deleteReplyTemplate,
  listReplyTemplates,
  MAX_TEMPLATES,
  orderForLanguage,
  saveReplyTemplate,
  templateContextForReview,
  TemplateError,
} from "@/replies/templates";
import { withTenant } from "@/lib/tenancy";

/**
 * Reply templates (P2-T5).
 *
 * The Definition of Done: "a user replies from a template or AI draft; templates
 * are tenant-scoped and localized." The AI draft is unchanged from P1a and still
 * covered by its own suite, so what is new here is the template half — and in
 * particular that a template is filled in from the *review's own row* rather
 * than from anything a browser sent.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];
let counter = 0;

type Fixture = { orgId: string; orgName: string; locationId: string };

async function makeFixture(label: string): Promise<Fixture> {
  const orgName = `Kahve ${label}`;
  const [org] = await getAdminDb()
    .insert(schema.organizations)
    .values({ name: orgName, slug: `tpl-${label}-${suffix}` })
    .returning({ id: schema.organizations.id });
  if (!org) throw new Error("organization insert returned nothing");
  orgIds.push(org.id);

  const [location] = await getAdminDb()
    .insert(schema.locations)
    .values({ organizationId: org.id, name: "Kadıköy" })
    .returning({ id: schema.locations.id });

  return { orgId: org.id, orgName, locationId: location!.id };
}

async function addReview(
  fixture: Fixture,
  options: { authorName?: string | null; language?: string | null } = {},
): Promise<string> {
  const [review] = await getAdminDb()
    .insert(schema.reviews)
    .values({
      organizationId: fixture.orgId,
      locationId: fixture.locationId,
      source: "mock",
      sourceReviewId: `tpl-${suffix}-${counter++}`,
      authorName: options.authorName === undefined ? "Selin" : options.authorName,
      language: options.language === undefined ? "tr" : options.language,
      rating: 5,
      text: "Harika.",
      postedAt: new Date(),
      rawPayload: {},
    })
    .returning({ id: schema.reviews.id });

  return review!.id;
}

afterAll(async () => {
  if (orgIds.length > 0) {
    await getAdminDb().delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
  }
  await closeDatabasePools();
});

describe("managing templates", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`crud-${counter++}`);
  });

  it("creates, lists, edits and deletes", async () => {
    const result = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const created = await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        name: "Teşekkür",
        body: "Teşekkürler {{author}}!",
        language: "tr",
        tags: ["positive"],
      });

      await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        id: created.id,
        name: "Teşekkür",
        body: "Çok teşekkürler {{author}}!",
        language: "tr",
      });

      const afterEdit = await listReplyTemplates(tx, fixture.orgId);
      const removed = await deleteReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        id: created.id,
      });

      return { afterEdit, removed, afterDelete: await listReplyTemplates(tx, fixture.orgId) };
    });

    expect(result.afterEdit).toHaveLength(1);
    expect(result.afterEdit[0]?.body).toBe("Çok teşekkürler {{author}}!");
    expect(result.removed).toBe(true);
    expect(result.afterDelete).toHaveLength(0);
  });

  it("keeps a Turkish and an English template with the same name apart", async () => {
    // Two rows, not one row with two translations: a good reply in one language
    // is rarely a translation of the other.
    const templates = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        name: "Thanks",
        body: "Teşekkürler!",
        language: "tr",
      });
      await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        name: "Thanks",
        body: "Thank you!",
        language: "en",
      });

      return listReplyTemplates(tx, fixture.orgId);
    });

    expect(templates).toHaveLength(2);
  });

  it("updates in place when the same name and language are saved again", async () => {
    const templates = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const base = {
        organizationId: fixture.orgId,
        role: "admin" as const,
        name: "Özür",
        language: "tr",
      };

      await saveReplyTemplate(tx, { ...base, body: "Özür dileriz." });
      await saveReplyTemplate(tx, { ...base, body: "Çok özür dileriz." });

      return listReplyTemplates(tx, fixture.orgId);
    });

    expect(templates).toHaveLength(1);
    expect(templates[0]?.body).toBe("Çok özür dileriz.");
  });

  it("refuses a member", async () => {
    // A template shapes what the whole team says in the business's name.
    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        saveReplyTemplate(tx, {
          organizationId: fixture.orgId,
          role: "member",
          name: "Nope",
          body: "…",
          language: "tr",
        }),
      ),
    ).rejects.toThrow(TemplateError);
  });

  it("refuses a member deleting one", async () => {
    const removed = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const created = await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        name: "Teşekkür",
        body: "Teşekkürler!",
        language: "tr",
      });

      return deleteReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "member",
        id: created.id,
      }).catch((error: unknown) => error);
    });

    expect(removed).toBeInstanceOf(TemplateError);
  });

  it("rejects a body longer than a reply may be", async () => {
    await expect(
      withTenant({ organizationId: fixture.orgId }, (tx) =>
        saveReplyTemplate(tx, {
          organizationId: fixture.orgId,
          role: "admin",
          name: "Uzun",
          body: "a".repeat(5_000),
          language: "tr",
        }),
      ),
    ).rejects.toThrow();
  });

  it("caps how many an organization may keep", async () => {
    await expect(
      withTenant({ organizationId: fixture.orgId }, async (tx) => {
        for (let index = 0; index <= MAX_TEMPLATES; index += 1) {
          await saveReplyTemplate(tx, {
            organizationId: fixture.orgId,
            role: "admin",
            name: `Template ${index}`,
            body: "Teşekkürler!",
            language: "tr",
          });
        }
      }),
    ).rejects.toThrow(TemplateError);
  });

  it("keeps templates inside their tenant", async () => {
    const neighbour = await makeFixture(`crud-other-${counter++}`);

    await withTenant({ organizationId: neighbour.orgId }, (tx) =>
      saveReplyTemplate(tx, {
        organizationId: neighbour.orgId,
        role: "admin",
        name: "Komşunun şablonu",
        body: "Merhaba!",
        language: "tr",
      }),
    );

    const seen = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      listReplyTemplates(tx, fixture.orgId),
    );

    expect(seen).toHaveLength(0);
  });
});

describe("filling a template in from a review", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture(`render-${counter++}`);
  });

  it("takes the author, location and business from the review's own row", async () => {
    const reviewId = await addReview(fixture);

    const rendered = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const resolved = await templateContextForReview(tx, fixture.orgId, reviewId);
      return renderTemplate(
        "Merhaba {{author}}, {{location}} şubemizi seçtiğiniz için teşekkürler — {{business}}",
        resolved!.context,
      );
    });

    expect(rendered).toBe(
      `Merhaba Selin, Kadıköy şubemizi seçtiğiniz için teşekkürler — ${fixture.orgName}`,
    );
  });

  it("closes the greeting cleanly for an anonymous reviewer", async () => {
    const reviewId = await addReview(fixture, { authorName: null });

    const rendered = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      const resolved = await templateContextForReview(tx, fixture.orgId, reviewId);
      return renderTemplate("Merhaba {{author}}, teşekkürler.", resolved!.context);
    });

    expect(rendered).toBe("Merhaba, teşekkürler.");
  });

  it("orders the picker by the review's language", async () => {
    const reviewId = await addReview(fixture, { language: "en" });

    const names = await withTenant({ organizationId: fixture.orgId }, async (tx) => {
      await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        name: "Teşekkür",
        body: "Teşekkürler!",
        language: "tr",
      });
      await saveReplyTemplate(tx, {
        organizationId: fixture.orgId,
        role: "admin",
        name: "Thanks",
        body: "Thank you!",
        language: "en",
      });

      const resolved = await templateContextForReview(tx, fixture.orgId, reviewId);
      const templates = await listReplyTemplates(tx, fixture.orgId);
      return orderForLanguage(templates, resolved!.language).map((entry) => entry.name);
    });

    expect(names[0]).toBe("Thanks");
    expect(names).toHaveLength(2);
  });

  it("reports nothing for a review in another tenant", async () => {
    const neighbour = await makeFixture(`render-other-${counter++}`);
    const reviewId = await addReview(neighbour);

    const resolved = await withTenant({ organizationId: fixture.orgId }, (tx) =>
      templateContextForReview(tx, fixture.orgId, reviewId),
    );

    expect(resolved).toBeNull();
  });
});
