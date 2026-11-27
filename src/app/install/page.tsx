import DbUnavailable from '@/components/DbUnavailable'
import { checkEnv, installGate, installGuard, isInstalled, isProdLike, testConnection } from '@/server/install'
import type { Metadata } from 'next'
import { forbidden } from 'next/navigation'
import { connection } from 'next/server'
import InstallWizard, { type EnvView, type WizardMode } from './components/InstallWizard'

export const metadata: Metadata = { title: 'Install' }
// The wizard's server actions (migrations) run under this route's limit on Vercel.
export const maxDuration = 60

export default async function Page() {
  await connection() // evaluated per request, never at build time
  const decision = installGuard(await isInstalled(), 'install')
  if (decision === 'forbidden') forbidden()
  if (decision === 'unavailable') return <DbUnavailable />

  const gate = installGate({ configured: process.env.INSTALL_TOKEN, prodLike: isProdLike(), presented: null })
  const mode: WizardMode = gate === 'allow' ? 'open' : gate === 'token-required' ? 'token' : gate
  let env: EnvView | null = null
  if (mode === 'open') {
    // Details (including connection errors) are only rendered when no token is required.
    const e = checkEnv()
    const conn = e.databaseUrl.ok ? await testConnection() : null
    env = { databaseUrl: e.databaseUrl, authSecret: e.authSecret, connection: conn, vercel: !!process.env.VERCEL }
  }
  return <InstallWizard mode={mode} initialEnv={env} />
}
