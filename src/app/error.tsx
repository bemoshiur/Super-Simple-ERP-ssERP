'use client'
import AuthShell from '@/components/AuthShell'
import Link from 'next/link'

/**
 * Error boundary for unexpected server/render errors. No error details are shown (they can contain data); the server
 * log keeps a safe summary, and the `digest` reference lets an administrator find that log line.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <AuthShell
      code="500"
      title="Something went wrong"
      lead={
        <>
          This page could not be shown. Try again; if it keeps happening, tell your administrator
          {error.digest ? (
            <>
              {' '}
              and quote the reference <code>{error.digest}</code>
            </>
          ) : null}
          .
        </>
      }
      centered
    >
      <div className="d-flex flex-wrap justify-content-center gap-2">
        <button type="button" className="btn btn-primary" onClick={reset}>
          Try again
        </button>
        <Link className="btn btn-light" href="/">
          Dashboard
        </Link>
      </div>
    </AuthShell>
  )
}
