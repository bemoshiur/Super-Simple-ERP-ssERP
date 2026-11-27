'use client'
import ConfirmDelete from '@/components/ui/ConfirmDelete'
import { toConfirmResult } from '@/components/ui/actionUi'
import Icon from '@/components/wrappers/Icon'
import { cloneRoleAction, createRoleAction, deleteRoleAction, updateRoleAction } from '@/server/actions/users'
import { isStrictlyBelow } from '@/server/iam/policy'
import { ACTIONS, MODULES, PERMISSIONS } from '@/server/rbac'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, Badge, Button, Form, Modal, Table } from 'react-bootstrap'

export type RoleRow = {
  id: string
  name: string
  isSystem: boolean
  userCount: number
  permissions: string[]
  canRename: boolean
  canEditPermissions: boolean
  canDelete: boolean
  /** This is the signed-in user's own role. */
  own: boolean
  /** Role does not exceed the signed-in user's permissions and is not their own (UI hint; the server decides). */
  manageable: boolean
  /** Its permissions are strictly fewer than the signed-in user's, so a copy may be created (UI hint; the server decides). */
  cloneable: boolean
}
type Props = { roles: RoleRow[]; grantable: string[] | null; can: { create: boolean; edit: boolean; delete: boolean } }
type Failure = { ok: false; error: string; fieldErrors?: Record<string, string> }

const MODULE_LABEL: Record<string, string> = { vendors: 'Vendors', customers: 'Customers', products: 'Products & stock', purchases: 'Purchases', sales: 'Sales', serials: 'Serials & service', accounts: 'Accounts & payments', reports: 'Reports', users: 'Users & roles', settings: 'Settings' }
const EXTRA = PERMISSIONS.filter((p) => !MODULES.some((m) => p.startsWith(`${m}.`)))
const EXTRA_LABEL: Record<string, string> = { 'activity.view': 'View activity log', 'branches.all': 'All branches (view every branch, switch branch)' }

/** Checkbox grid: module rows × view/create/edit/delete columns, plus non-CRUD keys (activity.view …). */
const PermissionMatrix = ({ value, onChange, grantable, readOnly }: { value: Set<string>; onChange: (s: Set<string>) => void; grantable: Set<string> | null; readOnly: boolean }) => {
  const allowed = (p: string) => !readOnly && (grantable === null || grantable.has(p))
  const toggle = (p: string, on: boolean) => {
    const next = new Set(value)
    if (on) next.add(p)
    else next.delete(p)
    onChange(next)
  }
  const toggleRow = (m: string, on: boolean) => {
    const next = new Set(value)
    for (const a of ACTIONS) {
      const p = `${m}.${a}`
      if (!allowed(p)) continue
      if (on) next.add(p)
      else next.delete(p)
    }
    onChange(next)
  }
  return (
    <Table size="sm" bordered responsive className="align-middle mb-2">
      <thead>
        <tr>
          <th>Module</th>
          {ACTIONS.map((a) => (
            <th key={a} className="text-center text-capitalize">
              {a}
            </th>
          ))}
          <th className="text-center">All</th>
        </tr>
      </thead>
      <tbody>
        {MODULES.map((m) => {
          const keys = ACTIONS.map((a) => `${m}.${a}`)
          const all = keys.every((k) => value.has(k))
          return (
            <tr key={m}>
              <td>{MODULE_LABEL[m] ?? m}</td>
              {keys.map((p) => (
                <td key={p} className="text-center">
                  <Form.Check className="d-inline-block" id={`perm-${p}`} aria-label={p} checked={value.has(p)} disabled={!allowed(p)} onChange={(e) => toggle(p, e.target.checked)} title={!allowed(p) && !readOnly ? 'You do not hold this permission' : p} />
                </td>
              ))}
              <td className="text-center">
                <Form.Check className="d-inline-block" id={`perm-row-${m}`} aria-label={`All ${m}`} checked={all} disabled={readOnly || !keys.some(allowed)} onChange={(e) => toggleRow(m, e.target.checked)} />
              </td>
            </tr>
          )
        })}
        {EXTRA.map((p) => (
          <tr key={p}>
            <td>{EXTRA_LABEL[p] ?? p}</td>
            <td className="text-center">
              <Form.Check className="d-inline-block" id={`perm-${p}`} aria-label={p} checked={value.has(p)} disabled={!allowed(p)} onChange={(e) => toggle(p, e.target.checked)} />
            </td>
            <td colSpan={4} className="text-muted small">
              {p}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

const RoleEditor = ({ role, grantable, onHide }: { role: RoleRow | null; grantable: string[] | null; onHide: () => void }) => {
  const router = useRouter()
  const [name, setName] = useState(role?.name ?? '')
  const [perms, setPerms] = useState(new Set(role?.permissions ?? []))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const readOnly = !!role && (!role.canEditPermissions || !role.manageable)
  const grantSet = grantable === null ? null : new Set(grantable)
  // Non-admins: a role must keep at least one permission fewer than their own (the server refuses an equal set).
  const equalToMine = grantSet !== null && !readOnly && !isStrictlyBelow({ adm: false, perms: grantSet }, perms)

  const submit = async () => {
    if (saving || readOnly || equalToMine) return
    setSaving(true)
    setError(null)
    setErrors({})
    try {
      const payload = { name, permissions: [...perms] }
      const res = role ? await updateRoleAction(role.id, payload) : await createRoleAction(payload)
      if (!res.ok) {
        setErrors((res as Failure).fieldErrors ?? {})
        setError((res as Failure).error)
        return
      }
      router.refresh()
      const out = res.data as { signedOut?: number }
      if (out.signedOut) setNotice(`Saved. ${out.signedOut} user(s) with this role were signed out and must sign in again.`)
      else onHide()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal show onHide={() => !saving && onHide()} centered size="lg" backdrop="static">
      <Form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title as="h5">{role ? `Role · ${role.name}` : 'New role'}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          {notice && <Alert variant="success">{notice}</Alert>}
          {role && !role.canEditPermissions && <Alert variant="info">The administrator role always has every permission and cannot be changed.</Alert>}
          {role?.own && <Alert variant="info">This is your own role. Another administrator must change it.</Alert>}
          {role && role.canEditPermissions && !role.manageable && !role.own && <Alert variant="info">You can only change roles with fewer permissions than your own.</Alert>}
          {!readOnly && role && role.userCount > 0 && (
            <Alert variant="warning" className="py-2">
              <Icon icon="log-out" className="me-1" /> Changing permissions signs out the {role.userCount} user(s) with this role; they must sign in again to get the new permissions.
            </Alert>
          )}
          <Form.Group className="mb-3" controlId="role-name">
            <Form.Label>Role name</Form.Label>
            <Form.Control value={name} onChange={(e) => setName(e.target.value)} maxLength={60} isInvalid={!!errors.name} disabled={readOnly || (!!role && !role.canRename)} />
            <Form.Control.Feedback type="invalid">{errors.name}</Form.Control.Feedback>
            {role && !role.canRename && <Form.Text className="text-muted">System roles keep their names.</Form.Text>}
          </Form.Group>
          <div className="d-flex justify-content-between align-items-center mb-2">
            <strong>Permissions</strong>
            <span className="text-muted small">{perms.size} selected</span>
          </div>
          {errors.permissions && <Alert variant="danger">{errors.permissions}</Alert>}
          <PermissionMatrix value={perms} onChange={setPerms} grantable={grantSet} readOnly={readOnly} />
          {equalToMine && (
            <Alert variant="warning" className="py-2 mb-2" role="status">
              A role you manage must have fewer permissions than your own: untick at least one of your permissions (this selection has all of them).
            </Alert>
          )}
          {grantSet && !readOnly && <p className="text-muted small mb-0">Greyed-out boxes are permissions you do not hold. You can only grant permissions you have, and a role must keep at least one fewer than yours.</p>}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            {notice || readOnly ? 'Close' : 'Cancel'}
          </Button>
          {!readOnly && !notice && (
            <Button type="submit" disabled={saving || equalToMine}>
              {saving ? 'Saving…' : role ? 'Save role' : 'Create role'}
            </Button>
          )}
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

const CloneModal = ({ role, onHide }: { role: RoleRow; onHide: () => void }) => {
  const router = useRouter()
  const [name, setName] = useState(`${role.name} copy`)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const res = await cloneRoleAction(role.id, { name })
      if (!res.ok) return setError(res.fieldErrors?.name ?? res.error)
      onHide()
      router.refresh()
    } catch {
      setError('Something went wrong. Please try again.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal show onHide={() => !saving && onHide()} centered>
      <Form
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Modal.Header closeButton>
          <Modal.Title as="h5">Clone role · {role.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {error && <Alert variant="danger">{error}</Alert>}
          <Form.Group controlId="clone-name">
            <Form.Label>New role name</Form.Label>
            <Form.Control value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Form.Group>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="light" onClick={onHide} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Cloning…' : 'Clone'}
          </Button>
        </Modal.Footer>
      </Form>
    </Modal>
  )
}

const RoleList = ({ roles, grantable, can }: Props) => {
  const router = useRouter()
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null)
  const [cloning, setCloning] = useState<RoleRow | null>(null)
  return (
    <>
      <div className="d-flex justify-content-between align-items-center mb-3">
        <p className="text-muted mb-0">Roles group permissions. A user has exactly one role. Permission changes sign affected users out so they pick up the new permissions.</p>
        {can.create && (
          <Button onClick={() => setEditing('new')}>
            <Icon icon="plus" className="me-1" /> New role
          </Button>
        )}
      </div>
      <Table responsive hover className="align-middle mb-0">
        <thead>
          <tr>
            <th>Role</th>
            <th className="text-end">Users</th>
            <th className="text-end">Permissions</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {roles.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="fw-semibold text-capitalize">{r.name}</span>
                {r.isSystem && (
                  <Badge bg="secondary-subtle" text="secondary" className="ms-2">
                    System
                  </Badge>
                )}
                {r.own && (
                  <Badge bg="primary-subtle" text="primary" className="ms-2">
                    Your role
                  </Badge>
                )}
              </td>
              <td className="text-end">{r.userCount}</td>
              <td className="text-end">{r.canEditPermissions ? r.permissions.length : 'All'}</td>
              <td>
                <div className="d-flex gap-1 justify-content-end">
                  <Button size="sm" variant="tonal-primary" onClick={() => setEditing(r)}>
                    <Icon icon={can.edit && r.manageable && r.canEditPermissions ? 'pencil' : 'eye'} className="me-1" />
                    {can.edit && r.manageable && r.canEditPermissions ? 'Edit' : 'View'}
                  </Button>
                  {can.create && r.cloneable && (
                    <Button size="sm" variant="tonal-secondary" onClick={() => setCloning(r)} aria-label={`Clone ${r.name}`}>
                      <Icon icon="copy" />
                    </Button>
                  )}
                  {can.delete && r.canDelete && r.manageable && (
                    <ConfirmDelete
                      itemName={r.name}
                      title="Delete this role?"
                      message={r.userCount > 0 ? `${r.userCount} user(s) still have this role. Move them to another role first.` : 'The role and its permission set are removed.'}
                      onConfirm={async () => {
                        const res = toConfirmResult(await deleteRoleAction(r.id))
                        if (!res.error) router.refresh()
                        return res
                      }}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {editing && <RoleEditor role={editing === 'new' ? null : { ...editing, manageable: editing.manageable && can.edit }} grantable={grantable} onHide={() => setEditing(null)} />}
      {cloning && <CloneModal role={cloning} onHide={() => setCloning(null)} />}
    </>
  )
}

export default RoleList
