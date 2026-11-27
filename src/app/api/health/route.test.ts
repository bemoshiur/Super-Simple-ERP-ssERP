import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Fresh module (and so a fresh cache) for every test.
let GET: (r: Request) => Promise<Response>

const req = (q = '') => new Request(`http://localhost/api/health${q}`)

describe('GET /api/health', () => {
  const saved = process.env.DATABASE_URL
  beforeEach(async () => {
    vi.resetModules()
    GET = (await import('./route')).GET
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = saved
  })

  it('answers ok without touching the database', async () => {
    delete process.env.DATABASE_URL // would throw if the plain probe tried to connect
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('?db=1 reports only up/down (no details) and 503 when the database is unusable', async () => {
    delete process.env.DATABASE_URL
    const res = await GET(req('?db=1'))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'degraded', db: 'down' })
  })

  it('?db=1 with an unreachable host stays generic', async () => {
    process.env.DATABASE_URL = 'postgresql://u:secretpw@127.0.0.1:1/x'
    const res = await GET(req('?db=1&x=1'))
    const text = JSON.stringify(await res.json())
    expect(res.status).toBe(503)
    expect(text).not.toMatch(/secretpw|127\.0\.0\.1/)
  })
})
