import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:3100", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "pnpm --dir ../api dev",
      url: "http://127.0.0.1:4100/health",
      reuseExistingServer: true,
      timeout: 180_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://fb3:fb3@localhost:55432/fb3",
        REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:56379",
        JWT_ACCESS_SECRET: "e2e-access-secret-at-least-32-characters",
        JWT_REFRESH_SECRET: "e2e-refresh-secret-at-least-32-characters",
        LOCAL_DEMO_MODE: "true",
        PORT: "4100",
      },
    },
    {
      command: "pnpm exec next dev -p 3100",
      url: "http://127.0.0.1:3100",
      reuseExistingServer: true,
      timeout: 180_000,
      env: { NEXT_PUBLIC_API_URL: "http://127.0.0.1:4100" },
    },
  ],
});
