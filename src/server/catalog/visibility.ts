/**
 * Cost visibility for product rows sent to client components. A product's list purchase price is cost information:
 * without profit visibility the key is OMITTED (not blanked), so it is not even in the serialised RSC props.
 */
export function productRowsForClient<T extends { purchasePrice: string }>(rows: T[], showCost: boolean): (Omit<T, 'purchasePrice'> & { purchasePrice?: string })[] {
  if (showCost) return rows
  return rows.map((r) => {
    const { purchasePrice: _hidden, ...rest } = r
    void _hidden
    return rest
  })
}
