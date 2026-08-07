import { redirectIfSignedIn } from "@/auth/session";
import { SignUpForm } from "@/components/auth/sign-up-form";

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // A signed-in visitor reaching sign-up is on the wrong screen: what they
  // usually want is a second *organization*, which is `/create-organization`,
  // not a second account with a second set of memberships.
  await redirectIfSignedIn((await searchParams).next);

  return <SignUpForm />;
}
