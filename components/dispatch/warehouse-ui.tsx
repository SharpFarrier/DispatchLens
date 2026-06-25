'use client'
import type { CSSProperties, ReactNode } from 'react'

const COLOUR_HEX: Record<string, string> = { Black: '#222', White: '#e8e8e8', Golden: '#c8a84b', Ivory: '#e8dcc8' }

export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const px = { sm: 16, md: 24, lg: 40 }[size]
  return (
    <div style={{
      width: px, height: px, border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
      borderRadius: '50%', animation: 'spin 0.7s linear infinite',
    }} />
  )
}

export function Badge({ status }: { status: string }) {
  const base: CSSProperties = { display: 'inline-flex', alignItems: 'center', fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 999 }
  const map: Record<string, CSSProperties> = {
    active: { ...base, background: 'var(--accent-bg)', color: 'var(--accent)' },
    edited: { ...base, background: 'var(--today-bg)', color: 'var(--today)' },
    deleted: { ...base, background: 'var(--critical-bg)', color: 'var(--critical)' },
    packed: { ...base, background: 'var(--accent-bg)', color: 'var(--accent)' },
    dispatched: { ...base, background: 'var(--dispatched-bg)', color: 'var(--dispatched)' },
  }
  return <span style={map[status] || map.active}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>
}

export function ColourDot({ colour }: { colour: string }) {
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', border: '1px solid var(--border2)', marginRight: 6, verticalAlign: 'middle', background: COLOUR_HEX[colour] || '#888' }} />
}

export function StatCard({ label, value, colour = 'accent', onClick, hint }: {
  label: string; value: ReactNode; colour?: string; onClick?: () => void; hint?: string
}) {
  const colourVar: Record<string, string> = { accent: 'var(--accent)', purple: '#9333ea', blue: '#2563eb', green: 'var(--dispatched)', gray: 'var(--text3)' }
  return (
    <div onClick={onClick}
      style={{
        background: 'var(--surface)', borderRadius: 14, border: '2px solid var(--border)', padding: 16,
        textAlign: 'center', cursor: onClick ? 'pointer' : 'default',
      }}>
      <div style={{ fontSize: 30, fontWeight: 800, color: colourVar[colour] || colourVar.accent }}>{value ?? '—'}</div>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: 'var(--text3)', marginTop: 4 }}>{label}</div>
      {hint && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

export function Alert({ type = 'warning', message }: { type?: 'warning' | 'danger' | 'success' | 'info'; message: string }) {
  const styles: Record<string, CSSProperties> = {
    warning: { background: 'var(--accent-bg)', borderColor: 'var(--border)', color: 'var(--accent)' },
    danger: { background: 'var(--critical-bg)', borderColor: 'var(--border)', color: 'var(--critical)' },
    success: { background: 'var(--dispatched-bg)', borderColor: 'var(--border)', color: 'var(--dispatched)' },
    info: { background: 'var(--accent-bg)', borderColor: 'var(--border)', color: 'var(--text2)' },
  }
  const icons: Record<string, string> = { warning: '⚠️', danger: '🚨', success: '✅', info: 'ℹ️' }
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: 12, borderRadius: 10, border: '1px solid', fontSize: 13, fontWeight: 600, ...styles[type] }}>
      <span>{icons[type]}</span><span>{message}</span>
    </div>
  )
}

export function EmptyState({ icon = '📋', message }: { icon?: string; message: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text3)' }}>
      <div style={{ fontSize: 36, marginBottom: 12 }}>{icon}</div>
      <p style={{ fontSize: 13, fontWeight: 500, margin: 0 }}>{message}</p>
    </div>
  )
}

export function MattressTag({ mattress }: { mattress: string | null }) {
  if (!mattress || mattress === 'N/A') return null
  return <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text3)', background: 'var(--bg2)', padding: '2px 8px', borderRadius: 6 }}>{mattress}</span>
}

export function Th({ label, sortKey, currentKey, currentDir, onSort, align = 'left' }: {
  label: string; sortKey: string; currentKey: string; currentDir: 'asc' | 'desc'; onSort: (k: string) => void; align?: 'left' | 'right' | 'center'
}) {
  const isActive = currentKey === sortKey
  const arrow = isActive ? (currentDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'
  return (
    <th onClick={() => onSort(sortKey)}
      style={{
        padding: '8px 12px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
        cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap', textAlign: align,
        color: isActive ? 'var(--accent)' : 'var(--text3)',
      }}>
      {label}
      <span style={{ marginLeft: 2, fontSize: 12, opacity: isActive ? 1 : 0.3 }}>{arrow}</span>
    </th>
  )
}
