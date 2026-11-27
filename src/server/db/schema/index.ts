/**
 * Known limitations
 * - Foreign keys are single-column, so cross-tenant integrity relies on application code
 *   scoping every query/mutation by company_id (taken from the session, never client input).
 * - unit_events is append-only by convention: the service layer must never UPDATE or DELETE it.
 */
export * from './core'
export * from './identity'
export * from './catalog'
export * from './parties'
export * from './purchasing'
export * from './sales'
export * from './accounting'
export * from './service'
export * from './transfers'
