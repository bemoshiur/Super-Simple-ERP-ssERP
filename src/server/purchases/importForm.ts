import { FieldErrors } from '../errors'
import { MAX_IMPORT_BYTES } from './importCsv'
import type { ImportInput } from './import'

const text = (fd: FormData, k: string) => {
  const v = fd.get(k)
  return typeof v === 'string' ? v : ''
}

/** FormData (upload + the invoice fields of the purchase form) -> ImportInput. The size is checked before the file is read. */
export async function importInputFromFormData(fd: FormData): Promise<ImportInput> {
  const f = fd.get('file')
  if (!f || typeof f === 'string' || typeof (f as Blob).arrayBuffer !== 'function') throw new FieldErrors({ file: 'Choose a CSV file.' }, 'Choose a CSV file.')
  if ((f as Blob).size > MAX_IMPORT_BYTES) throw new FieldErrors({ file: `The file is too large (max ${Math.round(MAX_IMPORT_BYTES / 1000)} KB).` }, 'The file is too large.')
  return {
    bytes: new Uint8Array(await (f as Blob).arrayBuffer()),
    vendorId: text(fd, 'vendorId'),
    date: text(fd, 'date'),
    note: text(fd, 'note'),
    discount: text(fd, 'discount'),
    paid: text(fd, 'paid'),
    accountId: text(fd, 'accountId'),
    idempotencyKey: text(fd, 'idempotencyKey') || null,
  }
}
