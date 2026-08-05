import { redirect } from "next/navigation";
import { listOrganizationsForUser } from "@/agency/clients";
import { CreateOrganizationForm } from "@/components/auth/create-organization-form";
import { OrganizationPicker } from "@/components/auth/organization-picker";
import { getSession } from "@/auth/session";

/**
 * Where a session with no active organization lands.
 *
 * **It used to be a bare create form, and that was the W1.1 bug's second half.**
 * A returning customer arrived here with a perfectly good organization and was
 * shown the one control that makes a duplicate. So the page now asks the
 * question that actually applies: if this person belongs to organizations, it
 * offers *those*, and creating is a link. Only somebody who genuinely belongs
 * to nothing — the moment after signup — gets the create form as the whole
 * screen.
 *
 * `?new=1` is the way back to the form from the picker. A query rather than a
 * second route because this is one question — "which workspace?" — with a rare
 * second answer.
 */
export default async function CreateOrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ new?: string }>;
}) {
  // Reachable only while signed in; otherwise the org would have no owner.
  const session = await getSession();
  if (!session) redirect("/sign-in");

  if ((await searchParams).new === "1") return <CreateOrganizationForm />;

  const organizations = await listOrganizationsForUser(session.user.id);
  if (organizations.length === 0) return <CreateOrganizationForm />;

  return <OrganizationPicker organizations={organizations.map(({ id, name }) => ({ id, name }))} />;
}
