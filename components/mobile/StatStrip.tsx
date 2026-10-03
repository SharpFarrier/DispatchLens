'use client'
import type { ReactNode } from 'react'

export interface Stat {
  label: string
  value: ReactNode
  tone?: 'default' | 'accent' | 'today' | 'ok' | 'critical'
  onClick?: () => void
}

const TONE: Record<string, string> = {
  default: 'var(--text)', accent: 'var(--accent)', today: 'var(--today)',
  ok: 'var(--dispatched)', critical: 'var(--critical)',
}

// One horizontal row of compact pills that scrolls inside its own container
// (never widens the page). Zero-value stats can be filtered by the caller.
export default function StatStrip({ stats }: { stats: Stat[] }) {
  return (
    <div style={{ position: 'relative', margin: '0 -14px 12px' }}>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 7, overflowX: 'auto', padding: '0 14px', scrollSnapType: 'x proximity', WebkitOverflowScrolling: 'touch' }}>
        {stats.map((s, i) => (
          <div key={i} onClick={s.onClick}
            style={{ flex: '0 0 auto', minWidth: 74, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '8px 12px', scrollSnapAlign: 'start', cursor: s.onClick ? 'pointer' : 'default' }}>
            <b style={{ display: 'block', fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono, monospace)', lineHeight: 1, color: TONE[s.tone || 'default'] }}>{s.value}</b>
            <span style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3, display: 'block', whiteSpace: 'nowrap' }}>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
