import { describe, expect, it } from 'vitest'
import { DEFAULT_TIMEZONE, appTimezone, emptyDashboard } from './dashboard'

describe('appTimezone', () => {
  it('defaults to Asia/Dhaka and accepts valid IANA names only', () => {
    expect(appTimezone({})).toBe(DEFAULT_TIMEZONE)
    expect(appTimezone({ APP_TIMEZONE: 'Asia/Kolkata' })).toBe('Asia/Kolkata')
    expect(appTimezone({ APP_TIMEZONE: 'America/Argentina/Buenos_Aires' })).toBe('America/Argentina/Buenos_Aires')
    expect(appTimezone({ APP_TIMEZONE: "x'; drop table users;--" })).toBe(DEFAULT_TIMEZONE)
    expect(appTimezone({ APP_TIMEZONE: '' })).toBe(DEFAULT_TIMEZONE)
    expect(appTimezone({ APP_TIMEZONE: 'Mars/Olympus_Mons' })).toBe(DEFAULT_TIMEZONE) // well-formed but unknown zone
  })
})

describe('emptyDashboard', () => {
  it('is all zeros so an empty DB renders cleanly', () => {
    expect(emptyDashboard()).toEqual({ salesToday: '0.00', salesMonth: '0.00', stockValue: '0.00', customerDue: '0.00', vendorDue: '0.00', lowStock: 0, last7: [], top: [] })
  })
})
