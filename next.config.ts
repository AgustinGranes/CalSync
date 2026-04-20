import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin uses native Node.js modules — must be external
  serverExternalPackages: ["firebase-admin"],

  async headers() {
    return [
      {
        source: "/api/calendar/:uid",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
