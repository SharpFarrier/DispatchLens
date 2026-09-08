'use client'
import type { ReactNode } from 'react'

export type BadgeVariant = 'today' | 'undecided' | 'critical' | 'short' | 'surplus' | 'sku' | 'neutral'

// One badge system for the whole app: fixed height, 6px radius, 3px 8px padding,
// 11px / 600, soft-fill. Replaces the scattered inline status treatments.
const VARIANTS: Record<BadgeVariant, { bg: string; fg: string; border: string; mono?: boolean }> = {
  today:      { bg: 'var(--amber-soft)', fg: 'var(--amber)', border: 'var(--amber-soft)' },
  undecided:  { bg: 'var(--panel-2)',    fg: 'var(--ink-2)', border: 'var(--line)' },
  critical:   { bg: 'var(--red-soft)',   fg: 'var(--red)',   border: 'var(--red-soft)' },
  short:      { bg: 'var(--red-soft)',   fg: 'var(--red)',   border: 'var(--red-soft)' },
  surplus:    { bg: 'var(--green-soft)', fg: 'var(--green)', border: 'var(--green-soft)' },
  sku:        { bg: 'var(--panel-2)',    fg: 'var(--ink-2)', border: 'var(--line)', mono: true },
  neutral:    { bg: 'var(--panel-2)',    fg: 'var(--ink-2)', border: 'var(--line)' },
}

export default function Badge({ variant = 'neutral', children, title, mono }: { variant?: BadgeVariant; children: ReactNode; title?: string; mono?: boolean }) {
  const v = VARIANTS[variant]
  const useMono = mono ?? v.mono
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 8px',
      borderRadius: 6, fontSize: 11, fontWeight: 600, lineHeight: 1,
      background: v.bg, color: v.fg, border: `1px solid ${v.border}`,
      whiteSpace: 'nowrap',
      fontFamily: useMono ? 'var(--font-mono)' : 'var(--font-sans)',
      fontVariantNumeric: useMono ? 'tabular-nums' : undefined,
    }}>{children}</span>
  )
}

// Map an urgency tier to a Badge variant (CRITICAL/short -> red, TODAY -> amber, else neutral).
export function tierVariant(tier: string | null | undefined): BadgeVariant {
  if (tier === 'CRITICAL') return 'critical'
  if (tier === 'TODAY') return 'today'
  return 'neutral'
}
