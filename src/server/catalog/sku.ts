/** Pure SKU suggestion helpers. */

/** Up to 4 uppercase ASCII letters/digits from the first words of a name; falls back to "PRD" (e.g. Bengali-only names). */
export function skuPrefix(name: string): string {
  const words = name
    .normalize('NFKD')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  if (words.length === 0) return 'PRD'
  const joined = words.length === 1 ? words[0].slice(0, 4) : words.map((w) => w[0]).join('').slice(0, 4)
  return joined.length >= 2 ? joined : (words[0] + 'XX').slice(0, 3)
}

/** Next `PREFIX-0001` style SKU given the SKUs that already exist with that prefix (case-insensitive). */
export function nextSku(prefix: string, existing: readonly string[], width = 4): string {
  const p = prefix.toUpperCase()
  let max = 0
  for (const s of existing) {
    const m = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`, 'i').exec(s)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${p}-${String(max + 1).padStart(width, '0')}`
}
