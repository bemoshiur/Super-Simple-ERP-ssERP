import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseEnv } from '../src/server/install-env'

/** Load .env.local into process.env without overriding variables that are already set. */
export function loadEnvLocal(dir = process.cwd()) {
  const file = path.join(dir, '.env.local')
  if (!existsSync(file)) return
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}
