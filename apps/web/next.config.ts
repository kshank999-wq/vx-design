import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@vx/contracts", "@vx/planning"],
  // Document parsers run on the server only.
  serverExternalPackages: ["mammoth", "unpdf"],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
