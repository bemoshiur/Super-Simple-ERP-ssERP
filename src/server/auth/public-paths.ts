/**
 * Exact allow-list of paths reachable without a session. Deliberately NOT extension-based:
 * `/x/y.csv` or `/customers/john.doe` must stay protected. Shell assets are bundled under
 * /_next/static (imports). public/ only holds examples/serials-import.csv, which is deliberately NOT listed: it is
 * downloaded from the signed-in purchase import page. Add explicit paths here (with a test) if a public asset is needed.
 */
const PUBLIC_PREFIXES = ['/install', '/api/install', '/auth', '/_next']
const PUBLIC_EXACT = ['/favicon.ico', '/icon.svg', '/robots.txt', '/api/health']

export function isPublic(pathname: string): boolean {
  if (PUBLIC_EXACT.includes(pathname)) return true
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/')
