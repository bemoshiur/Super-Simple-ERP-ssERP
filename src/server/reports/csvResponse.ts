/**
 * Hard caps for exports. An export that would exceed them is REFUSED (HTTP 413) instead of being cut short: a partial CSV
 * presented as complete is worse than none. Mutable only so tests can use a tiny cap.
 */
export const exportLimits = { reports: 50_000, payments: 50_000 }

/** 413 response telling the user to narrow the filters. */
export const tooLargeResponse = (what: string, limit: number): Response =>
  new Response(`This ${what} has more than ${limit.toLocaleString('en-US')} rows, which is too many to export in one file. Narrow the date range or filters and try again.`, { status: 413, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

/** A streamed text/csv download (UTF-8). The body is emitted in chunks so a large export never builds one huge buffer in the response. */
export function csvResponse(csv: string, fileName: string): Response {
  const enc = new TextEncoder()
  const CHUNK = 64 * 1024
  let pos = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= csv.length) return controller.close()
      let end = Math.min(pos + CHUNK, csv.length)
      // never split a surrogate pair
      const last = csv.charCodeAt(end - 1)
      if (end < csv.length && last >= 0xd800 && last <= 0xdbff) end += 1
      controller.enqueue(enc.encode(csv.slice(pos, end)))
      pos = end
    },
  })
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

/** The request body as text, or null once more than `max` bytes arrive (reading stops there). */
export async function readCapped(req: Request, max: number): Promise<string | null> {
  if (!req.body) return ''
  const reader = req.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    parts.push(value)
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    buf.set(p, off)
    off += p.byteLength
  }
  return new TextDecoder().decode(buf)
}
