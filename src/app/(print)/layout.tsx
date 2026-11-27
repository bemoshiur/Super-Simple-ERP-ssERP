import DbUnavailable from '@/components/DbUnavailable'
import { getSessionUser } from '@/server/auth/current'
import { installGuard, isInstalled } from '@/server/install'
import { redirect } from 'next/navigation'
import { connection } from 'next/server'
import type { ReactNode } from 'react'

/** Bare layout for printable documents: same install/session guards as (admin), no sidebar/topbar. */
const PrintLayout = async ({ children }: { children: ReactNode }) => {
  await connection()
  const decision = installGuard(await isInstalled(), 'app')
  if (decision === 'redirect-install') redirect('/install')
  if (decision === 'unavailable') return <DbUnavailable />
  const current = await getSessionUser()
  if (!current) redirect('/auth/login')
  return <div className="print-root">{children}</div>
}

export default PrintLayout
