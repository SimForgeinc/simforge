import type { NextConfig } from "next";
import { resolve } from "node:path";

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
    config.resolve.alias = {
      ...config.resolve.alias,
      "./traffic-provider/sumoWasmWorker.js": resolve(
        process.cwd(),
        "../packages/playback/src/traffic-provider/sumoWasmWorker.ts",
      ),
    };
    return config;
  },
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
