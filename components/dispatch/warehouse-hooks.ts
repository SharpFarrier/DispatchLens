'use client'
import { useState, useMemo } from 'react'
import { format } from 'date-fns'

// Generic sort hook
export function useSort<T extends Record<string, unknown>>(data: T[], defaultKey: string, defaultDir: 'asc' | 'desc' = 'desc') {
  const [sortKey, setSortKey] = useState(defaultKey)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(defaultDir)

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  const sorted = useMemo(() => {
    if (!data || !sortKey) return data
    return [...data].sort((a, b) => {
      let av = a[sortKey] as unknown
      let bv = b[sortKey] as unknown
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      av = String(av).toLowerCase()
      bv = String(bv).toLowerCase()
      if ((av as string) < (bv as string)) return sortDir === 'asc' ? -1 : 1
      if ((av as string) > (bv as string)) return sortDir === 'asc' ? 1 : -1
      return 0
    })
  }, [data, sortKey, sortDir])

  return { sorted, sortKey, sortDir, toggleSort }
}

interface DayGroupItem { created_at: string; pieces?: number; [k: string]: unknown }
export interface DayGroup<T> { dateKey: string; items: T[]; total: number }

// Groups a sorted flat item array by calendar date.
export function useDayGroups<T extends DayGroupItem>(sortedItems: T[]): DayGroup<T>[] {
  return useMemo(() => {
    if (!sortedItems || !sortedItems.length) return []
    const map = new Map<string, T[]>()
    for (const item of sortedItems) {
      const key = format(new Date(item.created_at), 'dd MMM yyyy')
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(item)
    }
    return Array.from(map.entries()).map(([dateKey, items]) => ({
      dateKey,
      items,
      total: items.reduce((s, i) => s + (i.pieces || 0), 0),
    }))
  }, [sortedItems])
}
