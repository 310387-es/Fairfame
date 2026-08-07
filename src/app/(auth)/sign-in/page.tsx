import { redirectIfSignedIn } from "@/auth/session";
import { SignInForm } from "@/components/auth/sign-in-form";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Already signed in: there is nothing to do here, and offering the form
  // anyway is how somebody ends up signed into a second account by accident.
  await redirectIfSignedIn((await searchParams).next);

  return <SignInForm />;
}
