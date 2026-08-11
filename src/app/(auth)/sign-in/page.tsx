import { redirectIfSignedIn } from "@/auth/session";
import { isGoogleAuthConfigured } from "@/auth/social";
import { SignInForm } from "@/components/auth/sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Already signed in: there is nothing to do here, and offering the form
  // anyway is how somebody ends up signed into a second account by accident.
  await redirectIfSignedIn((await searchParams).next);

  // Server-only read, passed down — see the note on the sign-up page.
  return <SignInForm googleEnabled={isGoogleAuthConfigured()} />;
}
