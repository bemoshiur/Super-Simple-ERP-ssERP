/**
 * Next.js 16 proxy (formerly middleware). DB-free on purpose: only verifies the JWT signature/expiry.
 * Revocation (user disabled, session_version bumped) is enforced server-side in getSession().
 * Never import src/server/db here.
 */
import { NextRequest, NextResponse } from 'next/server'
import { SESSION_COOKIE } from '@/server/auth/constants'
import { isApiPath, isPublic } from '@/server/auth/public-paths'
import { verifySession } from '@/server/auth/session'

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  if (isPublic(pathname)) return NextResponse.next()

  const session = await verifySession(request.cookies.get(SESSION_COOKIE)?.value)
  if (session) return NextResponse.next()

  if (isApiPath(pathname)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = request.nextUrl.clone()
  url.pathname = '/auth/login'
  url.search = ''
  url.searchParams.set('next', pathname + search)
  return NextResponse.redirect(url)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
