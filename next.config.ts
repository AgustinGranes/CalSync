import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow fetching from external iCal sources during SSR
  experimental: {},
  // Headers for the calendar API
  async headers() {
    return [
      {
        source: "/api/calendar",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
