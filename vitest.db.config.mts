import { defineConfig } from 'vitest/config'
import path from 'node:path'

// Integration tests against a real Postgres. Started by scripts/test-db.sh, which provides DATABASE_URL.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['src/**/*.db.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
