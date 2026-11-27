'use client'
import type { ReactNode } from 'react'

// Zod 4 checks whether it may JIT-compile parsers by calling `Function('')`, which a strict CSP (no 'unsafe-eval')
// reports as a violation. Interpreted parsers are fast enough for forms, so switch the check off in the browser by
// writing zod's global config object directly (same effect as z.config({ jitless: true })) - this keeps zod itself out
// of the root bundle for pages without forms.
const zodGlobal = globalThis as { __zod_globalConfig?: Record<string, unknown> }
// Mutate in place: zod may already hold a reference to this object.
;(zodGlobal.__zod_globalConfig ??= {}).jitless = true

/** Client-side runtime settings that must run before any page code. Authentication is enforced on the server. */
export default function ClientRuntime({ children }: { children: ReactNode }) {
  return children
}
