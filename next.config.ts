import createNextIntlPlugin from "next-intl/plugin";
import type { NextConfig } from "next";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // pino resolves its transport target (pino-pretty) at runtime in a worker
  // thread. Bundling breaks that resolution, so keep both external on the server.
  //
  // `@react-pdf/renderer` is external for a related reason: it loads fontkit and
  // resolves font files at runtime, and it is only ever used from a route
  // handler and the background worker — bundling it buys nothing and breaks the
  // resolution it does for itself.
  serverExternalPackages: ["pino", "pino-pretty", "@react-pdf/renderer"],
};

export default withNextIntl(nextConfig);
