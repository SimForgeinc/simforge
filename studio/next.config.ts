import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deprecated wire alias: pre-SimForge clients are forwarded to the single canonical handler tree.
  async rewrites() {
    return [
      {
        source: "/api/uniscenario/:path*",
        destination: "/api/simforge/:path*",
      },
    ];
  },
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
    "@simforge/asset-catalog",
    "@simforge/compiler",
    "@simforge/maps",
    "@simforge/openscenario",
    "@simforge/render",
    "@simforge/playback/traffic",
    "@simforge/viewer",
    "@simforge/editor",
    "@simforge/playback",
    "@simforge/scenario",
    "@simforge/engine",
  ],
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
