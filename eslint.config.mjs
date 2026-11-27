// ESLint flat config: Next.js core-web-vitals + TypeScript rules (from eslint-config-next).
import { defineConfig, globalIgnores } from 'eslint/config'
import coreWebVitals from 'eslint-config-next/core-web-vitals'
import typescriptRules from 'eslint-config-next/typescript'

export default defineConfig([
  ...coreWebVitals,
  ...typescriptRules,
  globalIgnores([
    // build output (eslint-config-next's defaults, restated because globalIgnores replaces them)
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // local-only, git-ignored folders: licensed reference copies named <Name>_v<version>/, agent tooling
    '*_v[0-9]*/**',
    '.superpowers/**',
    '.claude/**',
    '.playwright-mcp/**',
    '.remember/**',
  ]),
])
