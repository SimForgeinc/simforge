import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  serverExternalPackages: ["@electric-sql/pglite"],
  transpilePackages: [
    "@simforge/playback/traffic",
    "@simforge/viewer",
    "@simforge/editor",
    "@simforge/playback",
    "@simforge/scenario",
    "@simforge/engine",
  ],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
