import { redirectIfSignedIn } from "@/auth/session";
import { isGoogleAuthConfigured } from "@/auth/social";
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

  // Read here rather than in the form: `getEnv` is server-only, and a
  // `NEXT_PUBLIC_` mirror of whether a secret exists would be a second source
  // of truth for one fact.
  return <SignUpForm googleEnabled={isGoogleAuthConfigured()} />;
}
