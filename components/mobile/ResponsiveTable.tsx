'use client'
import type { ReactNode } from 'react'
import { useIsMobile } from '@/hooks/useIsMobile'

// Per-column config. On desktop every column renders in the <table>. On mobile only the
// roles below are shown in a card, so no table ever scrolls sideways on a phone.
export interface Column<T> {
  key: string
  header: ReactNode
  cell: (row: T) => ReactNode          // desktop cell
  // mobile card roles — a column fills at most one:
  mobile?: 'primary' | 'secondary' | 'badge' | 'meta'
  mobileLabel?: string                 // label shown before a meta value on the card
  align?: 'left' | 'right' | 'center'
  width?: number | string
  hideOnMobile?: boolean               // never show on the card (desktop-only column)
}

export interface ResponsiveTableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  cardAccessory?: (row: T) => ReactNode   // optional right-side control on each card (e.g. a Call button)
  empty?: ReactNode
  className?: string
}

export default function ResponsiveTable<T>({ columns, rows, rowKey, onRowClick, cardAccessory, empty, className }: ResponsiveTableProps<T>) {
  const isMobile = useIsMobile()

  if (rows.length === 0 && empty) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--text3)', fontSize: 13 }}>{empty}</div>
  }

  // ── Desktop: the real table (unchanged look) ──
  if (!isMobile) {
    return (
      <div className={className} style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} style={{ padding: '8px 10px', textAlign: c.align || 'left', color: 'var(--text3)', fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap', background: 'var(--bg2)', width: c.width }}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={rowKey(r)} onClick={() => onRowClick?.(r)} style={{ borderTop: '1px solid var(--border)', cursor: onRowClick ? 'pointer' : 'default' }}>
                {columns.map(c => (
                  <td key={c.key} style={{ padding: '8px 10px', textAlign: c.align || 'left', fontSize: 13 }}>{c.cell(r)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  // ── Mobile: card list (no table) ──
  const primary = columns.find(c => c.mobile === 'primary')
  const secondary = columns.find(c => c.mobile === 'secondary')
  const badges = columns.filter(c => c.mobile === 'badge' && !c.hideOnMobile)
  const metas = columns.filter(c => c.mobile === 'meta' && !c.hideOnMobile)

  return (
    <div className={className}>
      {rows.map(r => (
        <div key={rowKey(r)} onClick={() => onRowClick?.(r)}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, padding: 12, marginBottom: 9, cursor: onRowClick ? 'pointer' : 'default', position: 'relative' }}>
          {badges.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7, flexWrap: 'wrap' }}>
              {badges.map(c => <span key={c.key}>{c.cell(r)}</span>)}
              {cardAccessory && <span style={{ marginLeft: 'auto' }} onClick={e => e.stopPropagation()}>{cardAccessory(r)}</span>}
            </div>
          )}
          {primary && <div style={{ fontSize: 13, fontFamily: 'var(--font-mono, monospace)', fontWeight: 600, color: 'var(--accent)' }}>{primary.cell(r)}</div>}
          {secondary && <div style={{ fontSize: 13.5, fontWeight: 500, margin: '2px 0 7px', lineHeight: 1.3 }}>{secondary.cell(r)}</div>}
          {metas.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', fontSize: 12, color: 'var(--text3)' }}>
              {metas.map(c => (
                <span key={c.key}>{c.mobileLabel ? `${c.mobileLabel} ` : ''}<b style={{ color: 'var(--text2)', fontWeight: 600 }}>{c.cell(r)}</b></span>
              ))}
            </div>
          )}
          {badges.length === 0 && cardAccessory && <div style={{ marginTop: 8 }} onClick={e => e.stopPropagation()}>{cardAccessory(r)}</div>}
        </div>
      ))}
    </div>
  )
}
