import { defineConfig, devices } from '@playwright/test'

// Runs the mobile flows against the local demo (embedded PostgreSQL, demo identity).
// Install once: npm i -D @playwright/test && npx playwright install chromium
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3777', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx tsx scripts/aieq-local.ts',
    url: 'http://localhost:3777/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: 'iphone-se-liff', use: { ...devices['iPhone SE'], viewport: { width: 375, height: 620 } } },
    { name: 'iphone-14-liff', use: { ...devices['iPhone 14'], viewport: { width: 390, height: 720 } } },
    { name: 'iphone-14-plus-liff', use: { ...devices['iPhone 14 Plus'], viewport: { width: 430, height: 800 } } },
  ],
})
