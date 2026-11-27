import { describe, expect, it } from 'vitest'
import { likePattern, listHref, pageMeta, pageWindow, parseListParams } from './pagination'

describe('parseListParams', () => {
  it('defaults', () => {
    expect(parseListParams({})).toEqual({ q: '', page: 1, pageSize: 20, offset: 0 })
    expect(parseListParams(undefined)).toEqual({ q: '', page: 1, pageSize: 20, offset: 0 })
  })
  it('parses q and page, trims and collapses whitespace', () => {
    expect(parseListParams({ q: '  hello   world ', page: '3' })).toEqual({ q: 'hello world', page: 3, pageSize: 20, offset: 40 })
  })
  it('takes the first value of repeated params', () => {
    expect(parseListParams({ q: ['a', 'b'], page: ['2', '9'] }).page).toBe(2)
  })
  it('rejects junk pages instead of throwing', () => {
    for (const p of ['0', '-1', 'abc', '1.5', '', '99999999999', '1e3', ' 2']) expect(parseListParams({ page: p }).page, p).toBeGreaterThanOrEqual(1)
    expect(parseListParams({ page: 'abc' }).page).toBe(1)
    expect(parseListParams({ page: '-4' }).page).toBe(1)
    expect(parseListParams({ page: '0' }).page).toBe(1)
    expect(parseListParams({ page: '99999999999' }).page).toBe(1)
  })
  it('caps query length and clamps page size', () => {
    expect(parseListParams({ q: 'x'.repeat(500) }).q).toHaveLength(100)
    expect(parseListParams({}, { pageSize: 5000 }).pageSize).toBe(100)
    expect(parseListParams({}, { pageSize: 0 }).pageSize).toBe(20)
    expect(parseListParams({ page: '2' }, { pageSize: 10 }).offset).toBe(10)
  })
})

describe('likePattern', () => {
  it('escapes LIKE wildcards', () => {
    expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%')
    expect(likePattern('abc')).toBe('%abc%')
  })
})

describe('pageMeta', () => {
  it('handles empty lists', () => {
    expect(pageMeta(0, 1, 20)).toEqual({ page: 1, pageCount: 1, total: 0, start: 0, end: 0, hasPrev: false, hasNext: false })
  })
  it('computes ranges and clamps a stale page', () => {
    expect(pageMeta(45, 3, 20)).toMatchObject({ page: 3, pageCount: 3, start: 41, end: 45, hasPrev: true, hasNext: false })
    expect(pageMeta(45, 9, 20).page).toBe(3)
    expect(pageMeta(45, 1, 20)).toMatchObject({ start: 1, end: 20, hasNext: true })
  })
})

describe('listHref', () => {
  it('omits default page and empty q, keeps other params', () => {
    expect(listHref('/x', new URLSearchParams('status=open&page=4'), { page: 1 })).toBe('/x?status=open')
    expect(listHref('/x', new URLSearchParams('q=abc'), { page: 3 })).toBe('/x?q=abc&page=3')
  })
  it('a new search resets to page 1', () => {
    expect(listHref('/x', new URLSearchParams('page=5'), { q: 'phone' })).toBe('/x?q=phone')
    expect(listHref('/x', new URLSearchParams('q=old&page=5'), { q: '' })).toBe('/x')
  })
  it('works with server searchParams objects', () => {
    expect(listHref('/x', { q: 'a', tag: ['1', '2'] }, { page: 2 })).toBe('/x?tag=1&tag=2&q=a&page=2')
  })
})

describe('pageWindow', () => {
  it('shows ellipses for long lists', () => {
    expect(pageWindow(1, 3)).toEqual([1, 2, 3])
    expect(pageWindow(10, 20)).toEqual([1, null, 9, 10, 11, null, 20])
    expect(pageWindow(1, 20)).toEqual([1, 2, null, 20])
    expect(pageWindow(1, 1)).toEqual([1])
  })
})
