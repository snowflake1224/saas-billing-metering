// In same-origin deployments the browser calls /api/*; rewrites are resolved at build time, so
// API_INTERNAL_URL must be the API address reachable from the web container when `next build` runs in Docker.
const apiInternalUrl = (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const config = {
  output: "standalone",
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],
  async redirects() {
    return [
      { source: "/demo", destination: "/", permanent: false },
      { source: "/demo/:path*", destination: "/", permanent: false },
    ];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiInternalUrl}/:path*` }];
  },
};
export default config;
