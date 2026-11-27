/**
 * Cached, single-flight database liveness check for the public /api/health?db=1 probe.
 *
 * A timed-out check cannot be cancelled, so while the previous underlying check is still pending no new one is started
 * (the probe answers "down" immediately). That bounds the probe to at most one pooled connection, however long the
 * database stalls. A new check starts only after the previous one settled and the cache TTL expired.
 */
export type DbCheck = () => Promise<void>

export function createDbHealth(check: DbCheck, opts: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? 5000
  const timeoutMs = opts.timeoutMs ?? 3000
  const now = opts.now ?? Date.now
  let cached: { up: boolean; at: number } | null = null
  let inflight: Promise<boolean> | null = null
  let underlyingPending = false

  return async function dbIsUp(): Promise<boolean> {
    if (cached && now() - cached.at < ttlMs) return cached.up
    if (inflight) return inflight
    if (underlyingPending) return false

    underlyingPending = true
    const underlying = new Promise<void>((resolve, reject) => {
      try {
        check().then(resolve, reject)
      } catch (e) {
        reject(e)
      }
    })
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        underlyingPending = false
      })
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })
    inflight = Promise.race([underlying, timeout])
      .then((up) => {
        cached = { up, at: now() }
        return up
      })
      .finally(() => {
        clearTimeout(timer)
        inflight = null
      })
    return inflight
  }
}
