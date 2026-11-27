import { installGuard, isInstalled } from '@/server/install'
import DbUnavailable from '@/components/DbUnavailable'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import type { ReactNode } from 'react'

/** Not installed (or DB unreachable / env missing): send everyone to the wizard. */
export default async function AuthLayout({ children }: { children: ReactNode }) {
  await connection()
  const decision = installGuard(await isInstalled(), 'app')
  if (decision === 'redirect-install') redirect('/install')
  if (decision === 'unavailable') return <DbUnavailable />
  return children
}
