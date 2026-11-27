import type { NextConfig } from 'next'

const isProd = process.env.NODE_ENV === 'production'

/**
 * Content-Security-Policy, sent in REPORT-ONLY mode for now (browsers log violations, nothing is blocked). Tradeoff:
 * Next.js injects inline bootstrap scripts, and a nonce-based policy would force every page to render dynamically per
 * request, so script-src allows 'unsafe-inline'. The policy still pins every other source to this origin (no third-party
 * scripts, frames, or connections; icons are bundled locally) and forbids framing. `next dev` also needs 'unsafe-eval'.
 * Set CSP_ENFORCE=1 at BUILD time to send it as an enforcing Content-Security-Policy instead (headers are fixed at build;
 * the E2E suite passes with no violations either way).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self'${isProd ? '' : ' ws:'}`,
  "media-src 'self' blob:", // camera preview for barcode scanning
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ')

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  // The scanner uses the camera of this site only; everything else is off.
  { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: process.env.CSP_ENFORCE === '1' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only', value: csp },
  // HSTS only when the site is known to be served over HTTPS (Vercel, or HSTS=1 at build time behind your own TLS proxy).
  // includeSubDomains: every subdomain of this host must also serve HTTPS for a year once a browser has seen it.
  ...(isProd && (process.env.VERCEL === '1' || process.env.HSTS === '1') ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
]

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone) for the Dockerfile only (it sets SSERP_STANDALONE=1).
  // Off by default so `npm run build && npm start` keeps working; Vercel ignores it.
  output: process.env.SSERP_STANDALONE === '1' ? 'standalone' : undefined,
  poweredByHeader: false,
  experimental: {
    // Lets server components call forbidden() to return a real 403 (used by /install once installed).
    authInterrupts: true,
  },
  // The installer reads the committed drizzle/ migrations at runtime; make sure they ship with the server bundle.
  // Every route may read the journal for the pending-migrations check (/api/health?db=1, admin banner).
  outputFileTracingIncludes: {
    '/install': ['./drizzle/**/*'],
    '/**': ['./drizzle/meta/_journal.json'],
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
