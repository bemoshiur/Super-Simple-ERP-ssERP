import type { BranchFilter } from '../branch'
import type { Db } from '../db'
import type { CsvKind } from './csv'
import type { Group } from './pure'

export type Reader = Pick<Db, 'select' | 'execute'>

export type ReportColumn = { key: string; label: string; kind: CsvKind; /** Cost/profit-derived: stripped unless the viewer may see profit. */ sensitive?: boolean }
/** `_style` only affects on-screen rendering (headings/totals in the P&L); it is never exported. */
export type ReportRow = Record<string, string | number | null> & { _style?: 'heading' | 'total' | 'sub' }
export type ReportTable = { title?: string; columns: ReportColumn[]; rows: ReportRow[]; totals?: ReportRow }
export type ReportResult = { key: string; title: string; from?: string; to?: string; tables: ReportTable[]; notes: string[]; /** Lines appended to the CSV export (e.g. the cash-flow reconciliation result). */ exportNotes?: string[]; truncated: boolean }

export type ReportParams = {
  from: string
  to: string
  group: Group
  customerId?: string
  vendorId?: string
  productId?: string
  categoryId?: string
  days: 30 | 60 | 90
}

/** branch: the viewer's list/report filter (BranchScope.filter): one branch, or null = all branches. Never from the URL alone. */
export type ReportContext = { db: Db; companyId: string; branch: BranchFilter; today: string; canSeeProfit: boolean; limit: number }

/** Rows on screen (the CSV cap lives in csvResponse.ts). One extra row is fetched to detect truncation. */
export const SCREEN_ROW_CAP = 1000
