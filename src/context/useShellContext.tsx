'use client'
import type { MenuItemType } from '@/types'
import { createContext, use, type ReactNode } from 'react'

export type ShellUser = { name: string; email: string; role: string }
/**
 * Branch context for the top bar (Task 14). Absent / multi=false on single-branch installs: no branch UI at all.
 * value: the selected branch id or 'all' (only for branches.all holders); canSwitch: holds branches.all.
 */
export type ShellBranch = { multi: boolean; canSwitch: boolean; value: string; homeName: string; options: { id: string; name: string; code: string }[] }
export type ShellState = { menu: MenuItemType[]; user: ShellUser; branch?: ShellBranch }

const ShellContext = createContext<ShellState | null>(null)

/** Server-computed shell data (RBAC-filtered menu + current user) handed to the client layout. */
export const ShellProvider = ({ value, children }: { value: ShellState; children: ReactNode }) => <ShellContext value={value}>{children}</ShellContext>

export const useShell = (): ShellState => {
  const ctx = use(ShellContext)
  if (!ctx) throw new Error('useShell must be used within ShellProvider')
  return ctx
}

/** Same as useShell, but null outside the admin shell (components that may also render elsewhere). */
export const useOptionalShell = (): ShellState | null => use(ShellContext)
