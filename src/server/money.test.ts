import { describe, expect, it } from 'vitest'
import { fmt, fmtBD, fromMinor, mul, sum, toMinor } from './money'

describe('money', () => {
  it('converts to and from minor units', () => {
    expect(toMinor('12.34')).toBe(1234)
    expect(toMinor('0.3')).toBe(30)
    expect(toMinor(5)).toBe(500)
    expect(toMinor('-1.50')).toBe(-150)
    expect(fromMinor(1234)).toBe('12.34')
    expect(fromMinor(5)).toBe('0.05')
    expect(fromMinor(-150)).toBe('-1.50')
  })

  it('rounds half away from zero at 2 decimals', () => {
    expect(toMinor('1.005')).toBe(101)
    expect(toMinor(1.005)).toBe(101)
    expect(toMinor('1.004')).toBe(100)
    expect(toMinor('2.675')).toBe(268)
    expect(toMinor('-1.005')).toBe(-101)
  })

  it('sums 0.1 + 0.2 to exactly 0.30', () => {
    expect(0.1 + 0.2).not.toBe(0.3)
    expect(sum([0.1, 0.2])).toBe('0.30')
    expect(sum(['0.10', '0.20'])).toBe('0.30')
  })

  it('multiplies price by quantity exactly', () => {
    expect(mul('19.99', 3)).toBe('59.97')
    expect(() => mul('1', 1.5)).toThrow()
  })

  it('formats with the ৳ symbol and thousands separators', () => {
    expect(fmt('1234.5')).toBe('৳1,234.50')
    expect(fmt(0)).toBe('৳0.00')
    expect(fmt('1234567.891')).toBe('৳1,234,567.89')
    expect(fmt(-50)).toBe('-৳50.00')
    expect(fmt('10', '$')).toBe('$10.00')
  })

  it('normalises negative zero', () => {
    expect(Object.is(toMinor('-0'), 0)).toBe(true)
    expect(Object.is(toMinor('-0.001'), 0)).toBe(true)
    expect(Object.is(toMinor(-0), 0)).toBe(true)
  })

  it('accepts thousands commas but rejects decimal commas', () => {
    expect(toMinor('1,234.50')).toBe(123450)
    expect(() => toMinor('1,23')).toThrow()
    expect(() => toMinor('1,2345')).toThrow()
    expect(() => toMinor('12,34,5678')).toThrow()
    expect(() => toMinor('1,234,56')).toThrow()
    expect(() => toMinor('123,45,678')).toThrow()
    expect(() => toMinor(',123')).toThrow()
  })

  it('accepts western and Bangladeshi lakh grouping', () => {
    expect(toMinor('1,234,567')).toBe(123456700)
    expect(toMinor('1,00,000')).toBe(10000000)
    expect(toMinor('12,34,567')).toBe(123456700)
    expect(toMinor('12,34,567.50')).toBe(123456750)
    expect(toMinor('-1,23,45,678.9')).toBe(-1234567890)
    expect(toMinor('1,000')).toBe(100000)
  })

  it('rejects invalid input', () => {
    expect(() => toMinor('abc')).toThrow()
    expect(() => toMinor('')).toThrow()
    expect(() => toMinor(NaN)).toThrow()
  })
})

describe('fmtBD', () => {
  it('formats with lakh grouping and the taka symbol', () => {
    expect(fmtBD('0')).toBe('৳0.00')
    expect(fmtBD('999.5')).toBe('৳999.50')
    expect(fmtBD('1000')).toBe('৳1,000.00')
    expect(fmtBD('100000')).toBe('৳1,00,000.00')
    expect(fmtBD('1234567.5')).toBe('৳12,34,567.50')
    expect(fmtBD('123456789')).toBe('৳12,34,56,789.00')
    expect(fmtBD('-1234567')).toBe('-৳12,34,567.00')
    expect(fmtBD(1234567, '$')).toBe('$12,34,567.00')
  })
  it('round-trips with toMinor', () => {
    expect(toMinor(fmtBD('12345678.9').replace('৳', ''))).toBe(1234567890)
  })
})
