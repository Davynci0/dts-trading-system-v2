import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // one id per build, the same in the server and the browser code: a page left open while a new
    // version goes live sees a different id from /api/analysis and reloads itself (components/Dashboard.tsx)
    APP_BUILD: process.env.VERCEL_GIT_COMMIT_SHA || String(Date.now()),
  },
};

export default nextConfig;
