import { redirect } from "next/navigation";
import { getSession } from "@/auth/session";

/**
 * Phase 0 has no marketing site, so the root simply routes: signed-in users to
 * the app shell, everyone else to sign-in.
 */
export default async function RootPage() {
  redirect((await getSession()) ? "/home" : "/sign-in");
}
