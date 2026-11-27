import AuthShell from '@/components/AuthShell'
import Link from 'next/link'

/** Shown when the install state cannot be determined (any database error other than "tables missing"). */
export default function DbUnavailable() {
  return (
    <AuthShell
      title="Database unavailable"
      lead={
        <>
          ssERP could not reach its database, so it cannot tell whether it is installed. This is usually temporary. If it keeps happening, check that <code>DATABASE_URL</code> is
          correct and that the database server is running.
        </>
      }
      centered
    >
      <Link href="/" className="btn btn-primary">
        Try again
      </Link>
    </AuthShell>
  )
}
