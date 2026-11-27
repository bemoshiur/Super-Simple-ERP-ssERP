type Failure = { ok: false; error: string; fieldErrors?: Record<string, string> }
type Result = { ok: true } | Failure | { ok: true; data?: unknown }

/** Put server field errors on the matching form fields. Returns a form-level message when nothing mapped to a field. */
type FormLike = { getValues: () => object; setError: (name: never, error: { type: string; message: string }) => void }

export function applyActionErrors(form: FormLike, res: Failure): string | null {
  let mapped = false
  for (const [k, msg] of Object.entries(res.fieldErrors ?? {})) {
    if (k in form.getValues()) {
      form.setError(k as never, { type: 'server', message: msg })
      mapped = true
    }
  }
  return mapped ? null : res.error
}

/** Adapt an ActionResult to ConfirmDelete's `{ error }` contract. */
export function toConfirmResult(res: Result): { error?: string } {
  return res.ok ? {} : { error: (res as Failure).error }
}
