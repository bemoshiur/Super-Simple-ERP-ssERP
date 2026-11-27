import Link from 'next/link'
import Wordmark, { LogoMark } from './Wordmark'

/** Brand link (mark + wordmark) back to the dashboard. */
const AppLogo = ({ tone = 'dark', className, href = '/dashboard' }: { tone?: 'light' | 'dark'; className?: string; href?: string }) => (
  <Link href={href} className={className} aria-label="ssERP home">
    <LogoMark tone={tone} />
    <Wordmark tone={tone} />
  </Link>
)

export default AppLogo
