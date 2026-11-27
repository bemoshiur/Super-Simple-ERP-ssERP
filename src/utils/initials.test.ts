import { describe, expect, it } from 'vitest'
import { initials } from './initials'

describe('initials', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initials('Rahim Uddin Admin')).toBe('RA')
    expect(initials('  karim  ')).toBe('K')
    expect(initials('')).toBe('?')
  })
  it('does not split Bengali grapheme starts into broken code units', () => {
    expect(initials('সুমাইয়া আক্তার')).toBe('সআ')
  })
})
