import AuthShell from '@/components/AuthShell'
import Link from 'next/link'

/** 403 (e.g. /install once ssERP is installed). */
export default function Forbidden() {
  return (
    <AuthShell code="403" title="Not available" lead="This action is not available. If you were trying to run the installer, ssERP is already installed." centered>
      <Link className="btn btn-primary" href="/auth/login">
        Go to sign in
      </Link>
    </AuthShell>
  )
}
