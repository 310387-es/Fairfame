import { redirect } from "next/navigation";
import { CreateOrganizationForm } from "@/components/auth/create-organization-form";
import { getSession } from "@/auth/session";

export default async function CreateOrganizationPage() {
  // Reachable only while signed in; otherwise the org would have no owner.
  if (!(await getSession())) redirect("/sign-in");

  return <CreateOrganizationForm />;
}
