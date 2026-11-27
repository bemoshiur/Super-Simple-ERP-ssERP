'use client'
import { loginAction, type LoginState } from '@/server/auth/actions'
import { useActionState } from 'react'
import { Button, FormControl, FormLabel } from 'react-bootstrap'

const initial: LoginState = {}

export default function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, initial)
  return (
    <form action={action}>
      <input type="hidden" name="next" value={next} />
      <div className="mb-3">
        <FormLabel htmlFor="email">
          Email address <span className="text-danger">*</span>
        </FormLabel>
        <FormControl id="email" name="email" type="email" placeholder="you@example.com" autoComplete="username" required />
      </div>
      <div className="mb-3">
        <FormLabel htmlFor="password">
          Password <span className="text-danger">*</span>
        </FormLabel>
        <FormControl id="password" name="password" type="password" placeholder="••••••••" autoComplete="current-password" required />
      </div>
      {state.error && (
        <p className="text-danger" role="alert">
          {state.error}
        </p>
      )}
      <div className="d-grid">
        <Button variant="primary" type="submit" className="fw-semibold py-2" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign In'}
        </Button>
      </div>
    </form>
  )
}
