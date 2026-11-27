import { describe, expect, it } from 'vitest'
import { isApiPath, isPublic } from './public-paths'

describe('isPublic', () => {
  it('allows only the exact allow-list', () => {
    for (const p of ['/install', '/install/step', '/api/install', '/api/install/run', '/auth/login', '/_next/static/a.js', '/favicon.ico', '/icon.svg', '/robots.txt', '/api/health']) expect(isPublic(p), p).toBe(true)
  })
  it('protects extension-looking and lookalike paths', () => {
    for (const p of ['/x/y.csv', '/customers/john.doe', '/api/export.json', '/dashboard', '/', '/installer', '/authx', '/api/installx', '/_nextx/a', '/favicon.ico/x', '/logo.png', '/api/health/', '/api/health/x', '/api/healthz', '/api/health.json']) expect(isPublic(p), p).toBe(false)
  })
  it('detects api paths', () => {
    expect(isApiPath('/api/export.json')).toBe(true)
    expect(isApiPath('/apix')).toBe(false)
  })
})
