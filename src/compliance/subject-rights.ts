import { and, eq, inArray, sql } from "drizzle-orm";
import { schema } from "../db/client.ts";
import { childLogger } from "../lib/logger.ts";
import type { TenantDatabase } from "../lib/tenancy.ts";

/**
 * KVKK data-subject rights: export and erasure (P1b-T5).
 *
 * A person may ask a business what it holds about them, and may ask for it to
 * be deleted. Both are legal obligations with deadlines, and both are much
 * harder to satisfy if personal data has been scattered — which is why
 * `contacts` is the single place an email or phone lives, and why
 * `consent_records` and review payloads hold a contact *id* rather than the
 * person's details.
 *
 * The interesting decision here is what erasure does to a **review**.
 *
 * A review is not only personal data; it is also a public statement a business
 * received, and in most cases a statement still visible on the platform it came
 * from. Deleting the row would not unpublish it, would corrupt every historical
 * metric that counted it, and would misrepresent the business's own past. So
 * erasure **anonymises rather than deletes**: the identifying parts go, the
 * rating and the fact of the review remain.
 *
 * The text is a harder call, and it is deleted. A review can identify its
 * author by its content alone — "the couple who came in on my birthday with the
 * dog" — and keeping it would defeat the request while looking compliant.
 */

const log = childLogger({ module: "compliance/subject-rights" });

export type SubjectExport = {
  contact: {
    id: string;
    name: string | null;
    email: string | null;
    phone: string | null;
    locale: string | null;
    unsubscribedAt: Date | null;
    createdAt: Date;
  };
  consents: {
    type: string;
    channel: string | null;
    grantedAt: Date | null;
    revokedAt: Date | null;
    source: string | null;
    proofRef: string | null;
  }[];
  reviews: {
    id: string;
    source: string;
    itemType: string;
    rating: number | null;
    text: string | null;
    postedAt: Date | null;
  }[];
  requests: {
    channel: string;
    status: string;
    sentAt: Date | null;
    openedAt: Date | null;
    submittedAt: Date | null;
  }[];
  conversations: { lastInboundAt: Date | null; lastOutboundAt: Date | null }[];
};

/**
 * Everything held about one person, in a form that can be handed over.
 *
 * Deliberately assembled from named columns rather than `select *`: a new
 * column holding personal data should have to be added here consciously, and a
 * dump that silently grew to include internal scoring would be its own problem.
 */
export async function exportSubject(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
): Promise<SubjectExport | null> {
  const [contact] = await tx
    .select({
      id: schema.contacts.id,
      name: schema.contacts.name,
      email: schema.contacts.email,
      phone: schema.contacts.phone,
      locale: schema.contacts.locale,
      unsubscribedAt: schema.contacts.unsubscribedAt,
      createdAt: schema.contacts.createdAt,
    })
    .from(schema.contacts)
    .where(
      and(eq(schema.contacts.organizationId, organizationId), eq(schema.contacts.id, contactId)),
    )
    .limit(1);

  if (!contact) return null;

  const consents = await tx
    .select({
      type: schema.consentRecords.type,
      channel: schema.consentRecords.channel,
      grantedAt: schema.consentRecords.grantedAt,
      revokedAt: schema.consentRecords.revokedAt,
      source: schema.consentRecords.source,
      proofRef: schema.consentRecords.proofRef,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.contactRef, contactId),
      ),
    );

  const requests = await tx
    .select({
      channel: schema.reviewRequests.channel,
      status: schema.reviewRequests.status,
      sentAt: schema.reviewRequests.sentAt,
      openedAt: schema.reviewRequests.openedAt,
      submittedAt: schema.reviewRequests.submittedAt,
      reviewId: schema.reviewRequests.reviewId,
    })
    .from(schema.reviewRequests)
    .where(
      and(
        eq(schema.reviewRequests.organizationId, organizationId),
        eq(schema.reviewRequests.contactId, contactId),
      ),
    );

  const conversations = await tx
    .select({
      lastInboundAt: schema.whatsappConversations.lastInboundAt,
      lastOutboundAt: schema.whatsappConversations.lastOutboundAt,
    })
    .from(schema.whatsappConversations)
    .where(
      and(
        eq(schema.whatsappConversations.organizationId, organizationId),
        eq(schema.whatsappConversations.contactId, contactId),
      ),
    );

  const reviews = await reviewsForContact(tx, organizationId, requests);

  return {
    contact,
    consents,
    reviews,
    requests: requests.map(({ reviewId: _reviewId, ...rest }) => rest),
    conversations,
  };
}

/**
 * The reviews attributable to a contact.
 *
 * Two routes, because a review reaches us two ways. A first-party submission is
 * linked through `review_requests.review_id`. A review left directly on a
 * platform carries no contact id at all — we know the author only as a display
 * name the platform gave us, and matching on that would be guesswork that could
 * hand one person another's words. So only linked reviews are returned, and the
 * export is honest about covering what we can actually attribute.
 */
async function reviewsForContact(
  tx: TenantDatabase,
  organizationId: string,
  requests: { reviewId: string | null }[],
): Promise<SubjectExport["reviews"]> {
  const ids = requests.map((request) => request.reviewId).filter((id): id is string => id !== null);

  if (ids.length === 0) return [];

  return tx
    .select({
      id: schema.reviews.id,
      source: schema.reviews.source,
      itemType: schema.reviews.itemType,
      rating: schema.reviews.rating,
      text: schema.reviews.text,
      postedAt: schema.reviews.postedAt,
    })
    .from(schema.reviews)
    .where(and(eq(schema.reviews.organizationId, organizationId), inArray(schema.reviews.id, ids)));
}

export type ErasureResult = {
  contactDeleted: boolean;
  reviewsAnonymised: number;
  consentsRetained: number;
  requestsCleared: number;
};

/**
 * Erases a person, keeping only what the business must keep.
 *
 * What goes: the contact row and everything identifying in it, the review text,
 * the author name, and the raw payload — which is the one place a platform's
 * own copy of an email or a profile link survives.
 *
 * What stays, and why:
 *
 *   - **The review's rating and its existence.** Deleting it would not unpublish
 *     the review, would corrupt every metric that counted it, and would
 *     misrepresent the business's history. It becomes an unattributed data
 *     point, which is what it always was to the business.
 *   - **Consent records, revoked.** The obligation is to prove the state of a
 *     permission over time. A deleted record proves nothing — including that
 *     the person withdrew. `contact_ref` is a uuid pointing at a row that no
 *     longer exists, so it identifies nobody.
 *   - **Audit rows**, which never contained personal data in the first place.
 */
export async function eraseSubject(
  tx: TenantDatabase,
  organizationId: string,
  contactId: string,
  now = new Date(),
): Promise<ErasureResult> {
  const requests = await tx
    .select({ id: schema.reviewRequests.id, reviewId: schema.reviewRequests.reviewId })
    .from(schema.reviewRequests)
    .where(
      and(
        eq(schema.reviewRequests.organizationId, organizationId),
        eq(schema.reviewRequests.contactId, contactId),
      ),
    );

  const reviewIds = requests
    .map((request) => request.reviewId)
    .filter((id): id is string => id !== null);

  let reviewsAnonymised = 0;

  if (reviewIds.length > 0) {
    const rows = await tx
      .update(schema.reviews)
      .set({
        authorName: null,
        // A review can identify its author by its content alone. Keeping the
        // text would defeat the request while looking compliant.
        text: null,
        // The provider payload is the one place a platform's own copy of an
        // email or profile link survives.
        rawPayload: {},
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.reviews.organizationId, organizationId),
          inArray(schema.reviews.id, reviewIds),
        ),
      )
      .returning({ id: schema.reviews.id });

    reviewsAnonymised = rows.length;

    // Insights are derived from the text and an embedding can partially
    // reconstruct it, so they go with it.
    await tx
      .delete(schema.reviewInsights)
      .where(
        and(
          eq(schema.reviewInsights.organizationId, organizationId),
          inArray(schema.reviewInsights.reviewId, reviewIds),
        ),
      );
  }

  const consents = await tx
    .update(schema.consentRecords)
    .set({ revokedAt: sql`coalesce(${schema.consentRecords.revokedAt}, ${now})`, updatedAt: now })
    .where(
      and(
        eq(schema.consentRecords.organizationId, organizationId),
        eq(schema.consentRecords.contactRef, contactId),
      ),
    )
    .returning({ id: schema.consentRecords.id });

  // Deleting the contact cascades the conversation row and nulls the requests'
  // `contact_id`, keeping the funnel counts intact without the person in them.
  const deleted = await tx
    .delete(schema.contacts)
    .where(
      and(eq(schema.contacts.organizationId, organizationId), eq(schema.contacts.id, contactId)),
    )
    .returning({ id: schema.contacts.id });

  log.info(
    {
      organizationId,
      reviewsAnonymised,
      consentsRetained: consents.length,
      contactDeleted: deleted.length > 0,
    },
    "KVKK erasure completed",
  );

  return {
    contactDeleted: deleted.length > 0,
    reviewsAnonymised,
    consentsRetained: consents.length,
    requestsCleared: requests.length,
  };
}
