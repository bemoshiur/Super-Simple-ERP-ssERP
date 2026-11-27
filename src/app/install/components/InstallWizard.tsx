'use client'

import AuthShell from '@/components/AuthShell'
import Link from 'next/link'
import { useActionState, useCallback, useEffect, useState, useTransition } from 'react'
import { Alert, Badge, Button, Col, Form, Row, Spinner } from 'react-bootstrap'
import { checkEnvAction, createAdminAction, runMigrationsAction, type CreateAdminState, type EnvView, type MigrateState } from '../actions'

type Check = { ok: true } | { ok: false; error: string }
export type { EnvView }
export type WizardMode = 'open' | 'token' | 'disabled' | 'misconfigured'

const STEPS = ['Environment', 'Database', 'Company & admin', 'Done']

const Status = ({ label, check }: { label: string; check: Check | null }) => (
  <div className="d-flex align-items-start gap-2 mb-2">
    <Badge bg={check === null ? 'secondary' : check.ok ? 'success' : 'danger'} className="mt-1">
      {check === null ? 'Skipped' : check.ok ? 'OK' : 'Missing'}
    </Badge>
    <div>
      <code>{label}</code>
      {check && !check.ok && <div className="text-danger small">{check.error}</div>}
    </div>
  </div>
)

function EnvStep({ env, onContinue, onRecheck }: { env: EnvView; onContinue: () => void; onRecheck: () => Promise<void> }) {
  const [pending, start] = useTransition()
  const envReady = env.databaseUrl.ok && env.authSecret.ok
  const ready = envReady && env.connection?.ok === true
  return (
    <>
      <h4 className="mb-3">1. Check your environment</h4>
      <Status label="DATABASE_URL" check={env.databaseUrl} />
      <Status label="AUTH_SECRET" check={env.authSecret} />
      <Status label="Database connection" check={env.connection} />
      {env.connection && !env.connection.ok && <Alert variant="danger" className="py-2 small">Connection failed: {env.connection.error}</Alert>}

      {!envReady && (
        <div className="mt-3">
          <p className="text-muted mb-2">
            ssERP cannot write environment variables from the browser. Set them where the app runs, then press <strong>Re-check</strong>.
          </p>
          <Alert variant={env.vercel ? 'primary' : 'light'} className="small">
            <strong>On Vercel</strong>
            <ol className="mb-2 ps-3">
              <li>
                Open your project, then <em>Settings, Environment Variables</em>. Or add the <strong>Neon</strong> integration from the Vercel Marketplace, which sets <code>DATABASE_URL</code> for you.
              </li>
              <li>
                Add <code>DATABASE_URL</code> (your Neon connection string, <code>postgresql://user:password@host/db?sslmode=require</code>).
              </li>
              <li>
                Add <code>AUTH_SECRET</code>: any random string of 32+ characters. Generate one with{' '}
                <code>openssl rand -base64 48</code>.
              </li>
              <li>
                <em>Redeploy</em> (Deployments, Redeploy) so the new variables take effect, then come back here.
              </li>
            </ol>
          </Alert>
          <Alert variant={env.vercel ? 'light' : 'primary'} className="small">
            <strong>Running locally</strong>
            <p className="mb-1">
              Easiest: stop the server and run <code>npm run setup</code>. It asks for your Neon URL, generates <code>AUTH_SECRET</code>, writes <code>.env.local</code>, migrates and creates your admin account.
            </p>
            <p className="mb-0">
              Or create <code>.env.local</code> yourself (see <code>.env.example</code>) with <code>DATABASE_URL</code> and <code>AUTH_SECRET</code>, then restart <code>npm run dev</code>.
            </p>
          </Alert>
        </div>
      )}
      <div className="d-flex gap-2 mt-3">
        <Button variant="outline-secondary" disabled={pending} onClick={() => start(onRecheck)}>
          {pending ? <Spinner size="sm" /> : 'Re-check'}
        </Button>
        <Button disabled={!ready} onClick={onContinue}>
          Continue
        </Button>
      </div>
    </>
  )
}

function MigrateStep({ token, onDone }: { token: string | null; onDone: () => void }) {
  const [state, setState] = useState<MigrateState | null>(null)
  const [pending, start] = useTransition()
  const run = () =>
    start(async () => {
      setState(null)
      try {
        setState(await runMigrationsAction(token))
      } catch {
        setState({ ok: false, error: 'The request failed. Check the server logs and try again.' })
      }
    })
  return (
    <>
      <h4 className="mb-3">2. Create the database tables</h4>
      <p className="text-muted">Applies the bundled migrations to your Neon database. It is safe to run more than once.</p>
      {pending && (
        <Alert variant="info" className="d-flex align-items-center gap-2 py-2">
          <Spinner size="sm" /> Running migrations, this can take a few seconds...
        </Alert>
      )}
      {state?.ok === false && <Alert variant="danger" role="alert">{state.error}</Alert>}
      {state?.ok === true && <Alert variant="success">Migrations applied ({state.total} total). The database is ready.</Alert>}
      <div className="d-flex gap-2">
        <Button onClick={run} disabled={pending} variant={state?.ok ? 'outline-secondary' : 'primary'}>
          {state?.ok === false ? 'Retry' : state?.ok ? 'Run again' : 'Run migrations'}
        </Button>
        {state?.ok && <Button onClick={onDone}>Continue</Button>}
      </div>
    </>
  )
}

function AdminStep({ token, onDone }: { token: string | null; onDone: () => void }) {
  const [state, action, pending] = useActionState<CreateAdminState, FormData>(createAdminAction, {})
  useEffect(() => {
    if (state.ok) onDone()
  }, [state.ok, onDone])
  const fe = state.fieldErrors ?? {}
  const field = (name: string, label: string, props: React.ComponentProps<typeof Form.Control> = {}) => (
    <Form.Group className="mb-3" controlId={name}>
      <Form.Label>{label}</Form.Label>
      <Form.Control name={name} isInvalid={!!fe[name]} disabled={pending} required {...props} />
      <Form.Control.Feedback type="invalid">{fe[name]}</Form.Control.Feedback>
    </Form.Group>
  )
  return (
    <>
      <h4 className="mb-3">3. Your company and admin account</h4>
      {state.error && <Alert variant="danger" role="alert">{state.error}</Alert>}
      <Form action={action}>
        {token !== null && <input type="hidden" name="installToken" value={token} />}
        {field('companyName', 'Company name', { maxLength: 120, autoFocus: true })}
        <Row>
          <Col md={8}>{field('adminName', 'Your name', { maxLength: 120, autoComplete: 'name' })}</Col>
          <Col md={4}>{field('currency', 'Currency symbol', { defaultValue: '৳', maxLength: 8 })}</Col>
        </Row>
        {field('adminEmail', 'Admin email', { type: 'email', maxLength: 254, autoComplete: 'username' })}
        {field('adminPassword', 'Password (at least 10 characters)', { type: 'password', minLength: 10, autoComplete: 'new-password' })}
        {field('confirmPassword', 'Confirm password', { type: 'password', minLength: 10, autoComplete: 'new-password' })}
        <Button type="submit" disabled={pending}>
          {pending ? (
            <>
              <Spinner size="sm" className="me-2" />
              Installing...
            </>
          ) : (
            'Install ssERP'
          )}
        </Button>
      </Form>
    </>
  )
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <h4 className="mb-3">{title}</h4>
      <Alert variant="warning" role="alert">{children}</Alert>
    </>
  )
}

function TokenStep({ onVerified }: { onVerified: (token: string, env: EnvView) => void }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    start(async () => {
      setError(null)
      try {
        const r = await checkEnvAction(token)
        if (r.ok) onVerified(token, r.env)
        else setError(r.error)
      } catch {
        setError('The request failed. Check the server logs and try again.')
      }
    })
  }
  return (
    <Form onSubmit={submit}>
      <h4 className="mb-3">Enter your install token</h4>
      <p className="text-muted">
        This installer is protected. Enter the value of the <code>INSTALL_TOKEN</code> environment variable you set for this deployment.
      </p>
      {error && <Alert variant="danger" role="alert">{error}</Alert>}
      <Form.Group className="mb-3" controlId="installToken">
        <Form.Label>Install token</Form.Label>
        <Form.Control type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required disabled={pending} />
      </Form.Group>
      <Button type="submit" disabled={pending || token === ''}>
        {pending ? <Spinner size="sm" /> : 'Continue'}
      </Button>
    </Form>
  )
}

export default function InstallWizard({ mode, initialEnv }: { mode: WizardMode; initialEnv: EnvView | null }) {
  const [step, setStep] = useState(0)
  const [token, setToken] = useState<string | null>(null)
  const [env, setEnv] = useState<EnvView | null>(initialEnv)
  const goDone = useCallback(() => setStep(3), [])
  const recheck = async () => {
    const r = await checkEnvAction(token)
    if (r.ok) setEnv(r.env)
  }
  return (
    <AuthShell wide title="Install ssERP" lead="Four short steps: check the environment, create the database tables, then set up your company and the first administrator.">
              {mode === 'disabled' && (
                <Notice title="Web install is disabled">
                  Set <code>INSTALL_TOKEN</code> (16+ characters) in your environment variables and redeploy, or run <code>npm run setup</code> locally.
                </Notice>
              )}
              {mode === 'misconfigured' && (
                <Notice title="Install token too short">
                  <code>INSTALL_TOKEN</code> must be at least 16 characters. Fix it in your environment variables and redeploy.
                </Notice>
              )}
              {(mode === 'open' || mode === 'token') && (
                <>
                  <ol className="ss-steps" aria-label="Progress">
                    {STEPS.map((s, i) => (
                      <li key={s} className={i === step ? 'is-current' : i < step ? 'is-done' : undefined} aria-current={i === step ? 'step' : undefined}>
                        {i + 1}. {s}
                      </li>
                    ))}
                  </ol>
                  {step === 0 && !env && <TokenStep onVerified={(t, e) => { setToken(t); setEnv(e) }} />}
                  {step === 0 && env && <EnvStep env={env} onContinue={() => setStep(1)} onRecheck={recheck} />}
                  {step === 1 && <MigrateStep token={token} onDone={() => setStep(2)} />}
                  {step === 2 && <AdminStep token={token} onDone={goDone} />}
                  {step === 3 && (
                    <div className="text-center">
                      <h4 className="mb-3">4. All set</h4>
                      <Alert variant="success">ssERP is installed. The installer is now locked and cannot be run again.</Alert>
                      <Link href="/auth/login" className="btn btn-primary">
                        Sign in
                      </Link>
                    </div>
                  )}
                </>
              )}
    </AuthShell>
  )
}
