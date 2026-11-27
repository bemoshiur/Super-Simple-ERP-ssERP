import AuthShell from '@/components/AuthShell'
import Link from 'next/link'

/** 404 for unknown addresses. */
export default function NotFound() {
  return (
    <AuthShell code="404" title="Page not found" lead="Nothing lives at this address. It may have moved, or the link may be mistyped." centered>
      <Link className="btn btn-primary" href="/">
        Back to the dashboard
      </Link>
    </AuthShell>
  )
}
