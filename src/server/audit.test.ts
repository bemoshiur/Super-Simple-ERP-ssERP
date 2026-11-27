import { describe, expect, it, vi } from 'vitest'

vi.mock('./db', () => ({ getDb: () => { throw new Error('no db') }, schema: { activityLog: 'activity_log' } }))
import { isSecretKey, logActivity, redactSecrets } from './audit'

describe('redactSecrets', () => {
  it('drops secret-looking keys recursively, keeps the rest', () => {
    const input = {
      name: 'Rahim',
      passwordHash: 'x',
      nested: { apiToken: 't', otpCode: '123', keep: 1, list: [{ secret: 's', ok: true }, 'plain'] },
      AUTH_SECRET: 'z',
      resetTokenHash: 'h',
      when: new Date(0),
    }
    expect(redactSecrets(input)).toEqual({ name: 'Rahim', nested: { keep: 1, list: [{ ok: true }, 'plain'] }, when: '1970-01-01T00:00:00.000Z' })
  })

  it('knows the broader secret vocabulary without eating ordinary words', () => {
    for (const k of ['passwd', 'api_key', 'apiKey', 'x-api-key', 'Authorization', 'authorisation', 'cookie', 'setCookie', 'credentials', 'pin', 'pinCode', 'user_pin', 'session', 'sessionId', 'pwd'])
      expect(isSecretKey(k), k).toBe(true)
    for (const k of ['shipping', 'spinner', 'sessionsRevoked', 'otherSessionsRevoked', 'name', 'email', 'opinion', 'pinned'])
      expect(isSecretKey(k), k).toBe(false)
  })

  it('handles cycles (and shared, non-circular references) and non-plain objects', () => {
    const shared = { x: 1 }
    const root: Record<string, unknown> = { a: shared, b: shared, buf: Buffer.from('abc'), map: new Map([[1, 2]]), set: new Set([1]), big: BigInt(10) }
    root.self = root
    root.kids = [{ parent: root, token: 't' }, { parent: root }]
    class Thing {}
    root.thing = new Thing()
    const out = redactSecrets(root) as Record<string, unknown>
    expect(out).toEqual({
      a: { x: 1 },
      b: { x: 1 },
      buf: '[binary 3 bytes]',
      map: '[Map]',
      set: '[Set]',
      big: '10',
      self: '[Circular]',
      kids: [{ parent: '[Circular]' }, { parent: '[Circular]' }],
      thing: '[Thing]',
    })
    expect(() => JSON.stringify(out)).not.toThrow()
  })

  it('passes primitives through and does not mutate the input', () => {
    expect(redactSecrets('password')).toBe('password')
    expect(redactSecrets(5)).toBe(5)
    const o = { password: 'p' }
    redactSecrets(o)
    expect(o).toEqual({ password: 'p' })
  })
})

describe('logActivity', () => {
  it('redacts before/after before inserting', async () => {
    const values = vi.fn()
    const tx = { insert: () => ({ values }) } as never
    await logActivity({ companyId: 'c', action: 'user.update', entity: 'user', before: { email: 'a', passwordHash: 'h' }, after: { email: 'b', password: 'p' } }, tx)
    const row = values.mock.calls[0][0]
    expect(row.before).toEqual({ email: 'a' })
    expect(row.after).toEqual({ email: 'b' })
  })
})
