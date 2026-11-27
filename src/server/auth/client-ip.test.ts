import { describe, expect, it } from 'vitest'
import { DIRECT_BUCKET, clientIpFrom, proxyTrusted } from './client-ip'

const h = (o: Record<string, string>) => (n: string) => o[n] ?? null
const TRUSTED = { TRUSTED_PROXY: 'true' }

describe('clientIpFrom', () => {
  it('ignores all proxy headers unless a proxy is trusted (single constant bucket)', () => {
    const headers = h({ 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '6.6.6.6, 7.7.7.7' })
    expect(clientIpFrom(headers, {})).toBe(DIRECT_BUCKET)
    expect(clientIpFrom(headers, { TRUSTED_PROXY: 'false' })).toBe(DIRECT_BUCKET)
    expect(clientIpFrom(headers, { TRUSTED_PROXY: '1' })).toBe(DIRECT_BUCKET)
  })
  it('trusts headers when TRUSTED_PROXY=true or on Vercel', () => {
    expect(proxyTrusted({ TRUSTED_PROXY: 'true' })).toBe(true)
    expect(proxyTrusted({ VERCEL: '1' })).toBe(true)
    expect(proxyTrusted({})).toBe(false)
    expect(clientIpFrom(h({ 'x-real-ip': '5.5.5.5' }), { VERCEL: '1' })).toBe('5.5.5.5')
  })
  it('prefers x-real-ip, ignores spoofed leftmost XFF', () => {
    expect(clientIpFrom(h({ 'x-real-ip': '5.5.5.5', 'x-forwarded-for': '6.6.6.6, 7.7.7.7' }), TRUSTED)).toBe('5.5.5.5')
    expect(clientIpFrom(h({ 'x-forwarded-for': '1.2.3.4, 7.7.7.7' }), TRUSTED)).toBe('7.7.7.7')
    expect(clientIpFrom(h({}), TRUSTED)).toBe(DIRECT_BUCKET)
  })
  it('validates header values as IP literals', () => {
    expect(clientIpFrom(h({ 'x-real-ip': 'not-an-ip' }), TRUSTED)).toBe(DIRECT_BUCKET)
    expect(clientIpFrom(h({ 'x-real-ip': 'evil, 1.1.1.1' }), TRUSTED)).toBe(DIRECT_BUCKET)
    expect(clientIpFrom(h({ 'x-forwarded-for': '9.9.9.9, spoofed' }), TRUSTED)).toBe(DIRECT_BUCKET)
    expect(clientIpFrom(h({ 'x-real-ip': 'garbage', 'x-forwarded-for': '2.2.2.2' }), TRUSTED)).toBe('2.2.2.2')
    expect(clientIpFrom(h({ 'x-real-ip': '2001:db8::1' }), TRUSTED)).toBe('2001:db8::1')
  })
})
