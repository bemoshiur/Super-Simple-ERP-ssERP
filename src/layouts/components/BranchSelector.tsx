'use client'
import Icon from '@/components/wrappers/Icon'
import { useShell } from '@/context/useShellContext'
import { setActiveBranchAction } from '@/server/actions/branches'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { Form } from 'react-bootstrap'

/**
 * Top-bar branch selector (Task 14). Rendered only when the company has more than one active branch:
 *  - branches.all holders pick a branch (writes go there) or "All branches" (read-only view);
 *  - everyone else just sees the branch they work in.
 * The server re-validates the choice on every request; this control only stores it.
 */
const BranchSelector = () => {
  const { branch } = useShell()
  const router = useRouter()
  const [pending, start] = useTransition()
  if (!branch?.multi) return null
  if (!branch.canSwitch)
    return (
      <div className="ss-branch d-none d-sm-flex" title="Your branch">
        <Icon icon="building-2" aria-hidden="true" />
        <span className="text-truncate fw-semibold">{branch.homeName}</span>
      </div>
    )
  return (
    <div className="ss-branch">
      <Icon icon="building-2" className="d-none d-sm-inline" aria-hidden="true" />
      <Form.Select
        size="sm"
        aria-label="Branch"
        value={branch.value}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.value
          start(async () => {
            const r = await setActiveBranchAction(v)
            if (r.ok) router.refresh()
          })
        }}
      >
        <option value="all">All branches (view only)</option>
        {branch.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} ({o.code})
          </option>
        ))}
      </Form.Select>
    </div>
  )
}

export default BranchSelector
