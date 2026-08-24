import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: [
    "127.0.0.1",
    "100.72.252.40",
    "path-b860i-aorus-pro-ice",
    "path-b860i-aorus-pro-ice.tail1cad6a.ts.net",
  ],
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
