import { currentYear, META_DATA } from '@/config/constants'
import Link from 'next/link'
import type { ReactNode } from 'react'
import Wordmark, { LogoMark } from './Wordmark'

type Props = {
  children: ReactNode
  /** Installer: a wider card for the multi-step form. */
  wide?: boolean
  /** Card heading (rendered as the page's <h1>) and the sentence under it. */
  title?: ReactNode
  lead?: ReactNode
  /** Big status code above the title (error pages). */
  code?: string
  /** Centre the card's content (status pages). */
  centered?: boolean
}

/** Stand-alone page frame for sign-in, the installer and status pages: brand on a dark band, one card, a foot line. */
const AuthShell = ({ children, wide, title, lead, code, centered }: Props) => (
  <div className="ss-auth">
    <main id="main-content" className={`ss-auth__panel${wide ? ' is-wide' : ''}`}>
      <Link href="/" className="ss-auth__brand" aria-label="ssERP home">
        <LogoMark size={40} tone="light" />
        <Wordmark tone="light" />
      </Link>
      <div className={`card ss-auth__card${centered ? ' text-center' : ''}`}>
        {code && (
          <span className="ss-auth__code" aria-hidden="true">
            {code}
          </span>
        )}
        {title && <h1 className="ss-auth__title">{title}</h1>}
        {lead && <p className="ss-auth__lead">{lead}</p>}
        {children}
      </div>
      <p className="ss-auth__foot">
        © {currentYear} {META_DATA.name} · Super Simple ERP
      </p>
    </main>
  </div>
)

export default AuthShell
