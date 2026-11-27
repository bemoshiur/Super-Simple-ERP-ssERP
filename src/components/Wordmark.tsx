/**
 * ssERP brand: an SVG mark (a rounded tile with three ledger rows and a scan dot) and a text wordmark.
 * Both are drawn here; there are no image assets. `tone` picks colours for dark (navigation, sign-in backdrop) or light
 * backgrounds.
 */
type Tone = 'light' | 'dark'

export const LogoMark = ({ size = 28, tone = 'dark' }: { size?: number; tone?: Tone }) => (
  <svg className="ss-logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="8" fill={tone === 'light' ? '#4cc3bd' : '#1b6b8f'} />
    <rect x="7" y="8.5" width="18" height="3" rx="1.5" fill={tone === 'light' ? '#10273a' : '#fff'} />
    <rect x="7" y="14.5" width="12" height="3" rx="1.5" fill={tone === 'light' ? '#10273a' : '#fff'} opacity="0.85" />
    <rect x="7" y="20.5" width="7" height="3" rx="1.5" fill={tone === 'light' ? '#10273a' : '#fff'} opacity="0.7" />
    <circle cx="22.5" cy="22" r="2.75" fill={tone === 'light' ? '#10273a' : '#fff'} />
  </svg>
)

const Wordmark = ({ tone = 'dark', short = false }: { tone?: Tone; short?: boolean }) => (
  <span className={`ss-wordmark ${tone === 'light' ? 'is-light' : 'is-dark'}`}>
    ss{!short && <b>ERP</b>}
  </span>
)

export default Wordmark
