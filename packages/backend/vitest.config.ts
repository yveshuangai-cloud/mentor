import { defineConfig } from 'vitest/config'

// Unit tests live in test/; e2e/ holds Playwright specs that need a browser and are run with `npm run test:e2e`.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
})
