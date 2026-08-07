import { redirectIfSignedIn } from "@/auth/session";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export default async function ForgotPasswordPage() {
  // Somebody who is signed in has not forgotten their password. This is the
  // recovery flow for a person locked out — it proves control of a mailbox,
  // which a live session has already proved. Changing a password from inside
  // the app is a different act, and it belongs in settings behind the current
  // password rather than behind an emailed link.
  //
  // No `next`: nothing links here with a destination in mind.
  await redirectIfSignedIn();

  return <ForgotPasswordForm />;
}
