'use client'
import type { ReactNode } from 'react'

// Fixed bar above the bottom nav for a page's primary action. When rows are
// selected it shows "N selected · [action]". Only rendered on mobile by the caller.
export default function MobileActionBar({ selectedCount, label, onClick, disabled, variant = 'primary', navHeight = 58, children }: {
  selectedCount?: number
  label?: string
  onClick?: () => void
  disabled?: boolean
  variant?: 'primary' | 'ghost'
  navHeight?: number
  children?: ReactNode
}) {
  const primary = variant === 'primary'
  return (
    <div style={{ position: 'fixed', left: 0, right: 0, bottom: navHeight, minHeight: 62, background: 'rgba(255,255,255,0.94)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', zIndex: 40, paddingBottom: 'calc(10px + env(safe-area-inset-bottom, 0px))' }}>
      {typeof selectedCount === 'number' && selectedCount > 0 && (
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{selectedCount} selected</span>
      )}
      {children}
      {label && (
        <button onClick={onClick} disabled={disabled}
          style={{ flex: 1, height: 46, borderRadius: 12, border: primary ? 'none' : '1px solid var(--border2)', background: disabled ? 'var(--bg2)' : primary ? 'var(--accent)' : 'var(--surface)', color: disabled ? 'var(--text3)' : primary ? '#fff' : 'var(--text)', fontSize: 15, fontWeight: 700, cursor: disabled ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
          {label}
        </button>
      )}
    </div>
  )
}
