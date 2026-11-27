import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { newUuid } from './uuid'

afterEach(() => vi.unstubAllGlobals())

const realGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)

describe('newUuid', () => {
  it('uses randomUUID when present', () => {
    expect(z.uuid().safeParse(newUuid()).success).toBe(true)
  })
  it('on an insecure page (no randomUUID) builds a valid v4 UUID from getRandomValues', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => realGetRandomValues(a) })
    const ids = Array.from({ length: 200 }, newUuid)
    for (const id of ids) {
      expect(z.uuid().safeParse(id).success).toBe(true)
      expect(id[14]).toBe('4')
      expect('89ab').toContain(id[19])
    }
    expect(new Set(ids).size).toBe(200)
  })
  it('with no crypto at all still returns a UUID the server accepts', () => {
    vi.stubGlobal('crypto', undefined)
    expect(z.uuid().safeParse(newUuid()).success).toBe(true)
  })
})
