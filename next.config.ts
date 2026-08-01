import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pino resolves its transport target (pino-pretty) at runtime in a worker
  // thread. Bundling breaks that resolution, so keep both external on the server.
  serverExternalPackages: ["pino", "pino-pretty"],
};

export default nextConfig;
