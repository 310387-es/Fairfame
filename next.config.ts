import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // pino resolves its transport target (pino-pretty) at runtime in a worker
  // thread. Bundling breaks that resolution, so keep both external on the server.
  serverExternalPackages: ["pino", "pino-pretty"],
};

export default withNextIntl(nextConfig);
