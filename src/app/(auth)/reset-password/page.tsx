import { ResetPasswordForm } from "@/components/auth/reset-password-form";

/**
 * Where BetterAuth's `/reset-password/:token` endpoint sends somebody once it
 * has checked their link — the token arrives here as `?token=`, or `?error=`
 * when the link is dead (W1.9b).
 */
export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}
