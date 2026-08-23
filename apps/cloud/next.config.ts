import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: [
    "@uniscenarios/ambient-traffic",
    "@uniscenarios/city-renderer",
    "@uniscenarios/editor-core",
    "@uniscenarios/playback",
    "@uniscenarios/scenario-model",
    "@uniscenarios/sim-engine",
  ],
  experimental: {
    externalDir: true,
  },
};

export default nextConfig;
