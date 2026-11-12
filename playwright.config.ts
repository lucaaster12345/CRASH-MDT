import { defineConfig } from '@playwright/test'
import { testEnvironment } from './tests/fixtures.js'

const origin = 'http://127.0.0.1:38509'
const env = Object.fromEntries(
  Object.entries(testEnvironment(origin)).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  ),
)
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  use: {
    baseURL: origin,
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
    headless: true,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node --enable-source-maps dist/server/apps/server/index.js',
    url: origin + '/api/health',
    env,
    timeout: 15000,
    reuseExistingServer: false,
  },
})
