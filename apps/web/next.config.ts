import { isIP } from "node:net";
import type { NextConfig } from "next";

// In dev mode Next.js blocks its own assets for other hosts unless they are listed.
const bind = process.env.BIND_ADDRESS ?? "";
const devOrigins = isIP(bind) && bind !== "127.0.0.1" && bind !== "::1" ? [bind] : [];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  transpilePackages: ["@ao/shared"],
  allowedDevOrigins: devOrigins,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
