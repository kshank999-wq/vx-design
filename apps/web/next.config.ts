import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@vx/contracts", "@vx/planning", "@vx/power", "@vx/integrations", "@vx/flux"],
  // Document parsers run on the server only.
  serverExternalPackages: ["mammoth", "unpdf"],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
};

export default nextConfig;
