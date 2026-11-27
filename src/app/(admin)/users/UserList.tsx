'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import PaginatedTable from '@/components/ui/PaginatedTable'
import StatusFilter, { type StatusValue } from '@/components/ui/StatusFilter'
import { toConfirmResult } from '@/components/ui/actionUi'
import Icon from '@/components/wrappers/Icon'
import { activateUserAction, createUserAction, deactivateUserAction, resetUserPasswordAction, updateUserAction } from '@/server/actions/users'
import type { ColumnDef } from '@tanstack/react-table'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'
import { Alert, Badge, Button, Form, InputGroup, Modal } from 'react-bootstrap'

export type UserListRow = {
  id: string
  name: string
  email: string
  active: boolean
  roleId: string
  roleName: string
  branchId: string | null
  branchName: string | null
  lastLogin: string | null
  isSelf: boolean
  /** The signed-in user may manage this account (UI hint; the server decides). */
  manageable: boolean
}
type RoleOption = { id: string; name: string; assignable: boolean }
type Branch = { id: string; name: string }
type Props = {
  rows: UserListRow[]
  total: number
  page: number
  pageSize: number
  q: string
  status: StatusValue
  roleFilter: string
  roles: RoleOption[]
  branches: Branch[]
  can: { create: boolean; edit: boolean; delete: boolean }
}
type Failure = { ok: false; error: string; fieldErrors?: Record<string, string> }

/** Typed-or-generated password input used by "Add user" and "Reset password". */
const PasswordChoice = ({ generate, setGenerate, password, setPassword, error, label = 'Password' }: { generate: boolean; setGenerate: (b: boolean) => void; password: string; setPassword: (s: string) => void; error?: string; label?: string }) => {
  const [show, setShow] = useState(false)
  return (
    <Form.Group className="mb-3">
      <Form.Label>{label}</Form.Label>
      <Form.Check type="radio" id="pw-generate" name="pw-mode" label="Generate a strong one-time password (shown once)" checked={generate} onChange={() => setGenerate(true)} />
      <Form.Check type="radio" id="pw-type" name="pw-mode" label="Type a password" checked={!generate} onChange={() => setGenerate(false)} />
      {!generate && (
        <InputGroup className="mt-2" hasValidation>
          <Form.Control type={show ? 'text' : 'password'} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} isInvalid={!!error} aria-label="New password" />
          <Button variant="light" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
            <Icon icon={show ? 'eye-off' : 'eye'} />
          </Button>
          {error && <Form.Control.Feedback type="invalid">{error}</Form.Control.Feedback>}
        </InputGroup>
      )}
      {!generate && !error && <Form.Text className="text-muted">At least 10 characters.</Form.Text>}
    </Form.Group>
  )
}

/** Shows a server-generated password once, with a copy button. */
const OneTimePassword = ({ who, password, onClose }: { who: string; password: string; onClose: () => void }) => {
  const [copied, setCopied] = useState(false)
  return (
    <Modal show onHide={onClose} centered backdrop="static">
      <Modal.Header closeButton>
        <Modal.Title as="h5">Password for {who}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <Alert variant="warning" className="mb-3">
          Copy this password now and give it to the user privately. It will not be shown again.
        </Alert>
        <InputGroup>
          <Form.Control readOnly value={password} className="font-monospace" aria-label="One-time password" onFocus={(e) => e.currentTarget.select()} />
          <Button
            variant="primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(password)
                setCopied(true)
              } catch {
                setCopied(false)
              }
            }}
          >
            <Icon icon="copy" className="me-1" /> {copied ? 'Copied' : 'Copy'}
          </Button>
        </InputGroup>
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose}>Done</Button>
      </Modal.Footer>
    </Modal>
  )
}

const UserModal = ({ row, roles, branches, onHide, onGenerated }: { row: UserListRow | null; roles: RoleOption[]; branches: Branch[]; onHide: () => void; onGenerated: (who: string, pw: string) => void }) => {
  const router = useRouter()
  const [v, setV] = useState({ name: row?.name ?? '', email: row?.email ?? '', roleId: row?.roleId ?? '', branchId: row?.branchId ?? '' })
  const [currentPassword, setCurrentPassword] = useState('')
  const ownEmailChanged = !!row?.isSelf && v.email.trim().toLowerCase() !== row.email
  const [generate, setGenerate] = useState(true)
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const roleChanged = !!row && v.roleId !== row.roleId

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    setErrors({})
    try {
      // The server takes company/actor from the session and re-validates everything.
      const res = row ? await updateUserAction(row.id, ownEmailChanged ? { ...v, currentPassword } : v) : await createUserAction({ ...v, generate, password: generate ? undefined : password })
      if (!res.ok) {
        setErrors((res as Failure).fieldErrors ?? {})
        setError((res as Failure).error)
        return
      }
      const gen = !row && 'generatedPassword' in res.data ? (res.data as { generatedPassword?: string }).generatedPassword : undefined
      onHide()
      if (gen) onGenerated(v.name, gen)
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }))

  return (
    <Modal show onHide={() => !saving && onHide()} centered backdrop="static">
      <Form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title as="h5">{row ? 'Edit user' : 'Add user'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group className="mb-3" controlId="u-name">
            <Form.Label>Name</Form.Label>
            <Form.Control value={v.name} onChange={set('name')} maxLength={100} isInvalid={!!errors.name} />
            <Form.Control.Feedback type="invalid">{errors.name}</Form.Control.Feedback>
          </Form.Group>
          <Form.Group className="mb-3" controlId="u-email">
            <Form.Label>Email (used to sign in)</Form.Label>
            <Form.Control type="email" value={v.email} onChange={set('email')} maxLength={254} autoComplete="off" isInvalid={!!errors.email} />
            <Form.Control.Feedback type="invalid">{errors.email}</Form.Control.Feedback>
          </Form.Group>
          {ownEmailChanged && (
            <Form.Group className="mb-3" controlId="u-current-password">
              <Form.Label>Your current password</Form.Label>
              <Form.Control type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} maxLength={200} autoComplete="current-password" isInvalid={!!errors.currentPassword} />
              <Form.Control.Feedback type="invalid">{errors.currentPassword}</Form.Control.Feedback>
              <Form.Text className="text-muted">Needed to change the email you sign in with.</Form.Text>
            </Form.Group>
          )}
          <Form.Group className="mb-3" controlId="u-role">
            <Form.Label>Role</Form.Label>
            <Form.Select value={v.roleId} onChange={set('roleId')} isInvalid={!!errors.roleId} disabled={row?.isSelf}>
              <option value="">Choose a role…</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id} disabled={!r.assignable && r.id !== row?.roleId}>
                  {r.name}
                  {!r.assignable ? ' (exceeds your permissions)' : ''}
                </option>
              ))}
            </Form.Select>
            <Form.Control.Feedback type="invalid">{errors.roleId}</Form.Control.Feedback>
            {row?.isSelf && <Form.Text className="text-muted">You cannot change your own role.</Form.Text>}
            {roleChanged && <Form.Text className="text-warning">Changing the role signs this user out; they must sign in again.</Form.Text>}
          </Form.Group>
          {branches.length > 1 && (
            <Form.Group className="mb-3" controlId="u-branch">
              <Form.Label>Branch</Form.Label>
              <Form.Select value={v.branchId} onChange={set('branchId')} isInvalid={!!errors.branchId} disabled={row?.isSelf}>
                {!row && <option value="">Main (default)</option>}
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Form.Select>
              <Form.Control.Feedback type="invalid">{errors.branchId}</Form.Control.Feedback>
            </Form.Group>
          )}
          {!row && <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} error={errors.password} />}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : row ? 'Save user' : 'Create user'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

const ResetPasswordModal = ({ row, onHide, onGenerated }: { row: UserListRow; onHide: () => void; onGenerated: (who: string, pw: string) => void }) => {
  const [generate, setGenerate] = useState(true)
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    setErrors({})
    try {
      const res = await resetUserPasswordAction(row.id, { generate, password: generate ? undefined : password })
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {})
        setError(res.error)
        return
      }
      onHide()
      if (res.data.generatedPassword) onGenerated(row.name, res.data.generatedPassword)
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal show onHide={() => !saving && onHide()} centered backdrop="static">
      <Form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title as="h5">Reset password · {row.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <p className="text-muted">The user is signed out of every device and must sign in with the new password.</p>
          <PasswordChoice generate={generate} setGenerate={setGenerate} password={password} setPassword={setPassword} error={errors.password} label="New password" />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="warning" disabled={saving}>
            {saving ? 'Saving…' : 'Reset password'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

const RoleFilter = ({ value, roles }: { value: string; roles: RoleOption[] }) => {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const [pending, start] = useTransition()
  return (
    <Form.Select
      size="sm"
      style={{ width: 'auto' }}
      aria-label="Filter by role"
      value={value}
      disabled={pending}
      onChange={(e) => {
        const params = new URLSearchParams(sp.toString())
        params.delete('page')
        if (e.target.value) params.set('role', e.target.value)
        else params.delete('role')
        const qs = params.toString()
        start(() => router.push(qs ? `${pathname}?${qs}` : pathname))
      }}
    >
      <option value="">All roles</option>
      {roles.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </Form.Select>
  )
}

const UserList = ({ rows, total, page, pageSize, q, status, roleFilter, roles, branches, can }: Props) => {
  const router = useRouter()
  const [editing, setEditing] = useState<UserListRow | 'new' | null>(null)
  const [resetting, setResetting] = useState<UserListRow | null>(null)
  const [shown, setShown] = useState<{ who: string; password: string } | null>(null)
  const [rowError, setRowError] = useState<string | null>(null)
  const onGenerated = (who: string, password: string) => setShown({ who, password })

  const columnDefs = useMemo(
    () =>
      [
        {
          id: 'name',
          header: 'User',
          enableSorting: false,
          cell: ({ row }) => (
            <div>
              <div className="fw-semibold">
                {row.original.name}
                {row.original.isSelf && (
                  <Badge bg="primary-subtle" text="primary" className="ms-2">
                    You
                  </Badge>
                )}
              </div>
              <small className="text-muted">{row.original.email}</small>
            </div>
          ),
        },
        { id: 'role', header: 'Role', enableSorting: false, cell: ({ row }) => <span className="text-capitalize">{row.original.roleName}</span> },
        { id: 'branch', header: 'Branch', enableSorting: false, accessorFn: (r) => r.branchName ?? '-' },
        { id: 'lastLogin', header: 'Last sign-in', enableSorting: false, accessorFn: (r) => r.lastLogin ?? 'Never' },
        {
          id: 'active',
          header: 'Status',
          enableSorting: false,
          cell: ({ row }) => (row.original.active ? <Badge bg="success-subtle" text="success">Active</Badge> : <Badge bg="secondary-subtle" text="secondary">Inactive</Badge>),
        },
        {
          id: 'actions',
          header: '',
          enableSorting: false,
          cell: ({ row }) => {
            const r = row.original
            if (!r.manageable) return <small className="text-muted d-block text-end">Same or higher role</small>
            return (
              <div className="d-flex gap-1 justify-content-end">
                {can.edit && (
                  <Button size="sm" variant="tonal-primary" className="btn-square" aria-label={`Edit ${r.name}`} title="Edit" onClick={() => setEditing(r)}>
                    <Icon icon="pencil" />
                  </Button>
                )}
                {can.edit && !r.isSelf && (
                  <Button size="sm" variant="tonal-warning" className="btn-square" aria-label={`Reset password of ${r.name}`} title="Reset password" onClick={() => setResetting(r)}>
                    <Icon icon="key-round" />
                  </Button>
                )}
                {r.active && can.delete && !r.isSelf && (
                  <ConfirmDelete
                    itemName={`${r.name} (${r.email})`}
                    title="Deactivate this user?"
                    message="They are signed out immediately and can no longer sign in. Their history is kept and you can reactivate them later."
                    confirmLabel="Deactivate"
                    onConfirm={async () => {
                      const res = toConfirmResult(await deactivateUserAction(r.id))
                      if (!res.error) router.refresh()
                      return res
                    }}
                  />
                )}
                {!r.active && can.edit && !r.isSelf && (
                  <Button
                    size="sm"
                    variant="tonal-success"
                    onClick={async () => {
                      setRowError(null)
                      const res = await activateUserAction(r.id)
                      if (!res.ok) setRowError(res.error)
                      else router.refresh()
                    }}
                  >
                    Reactivate
                  </Button>
                )}
              </div>
            )
          },
        },
      ] as ColumnDef<UserListRow, never>[],
    [can.edit, can.delete, router],
  )

  return (
    <>
      {rowError && (
        <Alert variant="danger" dismissible onClose={() => setRowError(null)}>
          {rowError}
        </Alert>
      )}
      <div className="d-flex flex-wrap gap-2 mb-3">
        <StatusFilter value={status} />
        <RoleFilter value={roleFilter} roles={roles} />
      </div>
      <PaginatedTable
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        q={q}
        columnDefs={columnDefs}
        searchPlaceholder="Search name or email…"
        itemsName="users"
        emptyTitle="No users found"
        toolbar={
          can.create ? (
            <Button onClick={() => setEditing('new')}>
              <Icon icon="user-plus" className="me-1" /> Add user
            </Button>
          ) : undefined
        }
      />
      {editing && <UserModal row={editing === 'new' ? null : editing} roles={roles} branches={branches} onHide={() => setEditing(null)} onGenerated={onGenerated} />}
      {resetting && <ResetPasswordModal row={resetting} onHide={() => setResetting(null)} onGenerated={onGenerated} />}
      {shown && <OneTimePassword who={shown.who} password={shown.password} onClose={() => setShown(null)} />}
    </>
  )
}

export default UserList
