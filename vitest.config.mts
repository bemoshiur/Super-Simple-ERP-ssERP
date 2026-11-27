import { configDefaults, defineConfig } from 'vitest/config'
import path from 'node:path'

// Plain `npm test` runs pure unit tests only. Real-database tests (*.db.test.ts) run via `npm run test:db`.
export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, 'src') } },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.db.test.ts'],
    environment: 'node',
  },
})
