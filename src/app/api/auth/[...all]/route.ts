import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/auth/config";

/** All BetterAuth endpoints: /api/auth/sign-in, /sign-up, /organization/*, ... */
export const { GET, POST } = toNextJsHandler(auth);
