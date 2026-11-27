import AuthShell from '@/components/AuthShell'
import { safeNext } from '@/server/auth/constants'
import type { Metadata } from 'next'
import LoginForm from './components/LoginForm'

export const metadata: Metadata = { title: 'Sign In' }

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams
  return (
    <AuthShell title="Sign in" lead="Use the email address and password your administrator gave you.">
      <LoginForm next={safeNext(next)} />
    </AuthShell>
  )
}
