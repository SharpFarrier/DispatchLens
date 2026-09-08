'use client'
import { useState, useRef, useEffect, useCallback } from 'react'
import { Calendar } from 'lucide-react'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const ITEM_H = 34            // px per wheel item
const PAD = 2                // items of padding top/bottom so the selection sits centred

function daysInMonth(y: number, m: number) { return new Date(y, m + 1, 0).getDate() }
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`

// A single scroll-snap wheel. Reports the centred index on scroll settle.
function Wheel({ items, index, onChange, width }: { items: string[]; index: number; onChange: (i: number) => void; width: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = index * ITEM_H
  }, []) // set initial once
  const onScroll = () => {
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      const el = ref.current; if (!el) return
      const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / ITEM_H)))
      el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' })
      if (i !== index) onChange(i)
    }, 90)
  }
  return (
    <div ref={ref} onScroll={onScroll} style={{
      width, height: ITEM_H * (PAD * 2 + 1), overflowY: 'auto' as const, scrollSnapType: 'y mandatory' as const,
      WebkitOverflowScrolling: 'touch' as const,
    }} className="no-scrollbar">
      <div style={{ height: ITEM_H * PAD }} />
      {items.map((it, i) => (
        <div key={i} onClick={() => { ref.current?.scrollTo({ top: i * ITEM_H, behavior: 'smooth' }); onChange(i) }}
          style={{ height: ITEM_H, scrollSnapAlign: 'center' as const, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, fontWeight: i === index ? 600 : 400, color: i === index ? 'var(--ink)' : 'var(--ink-3)',
            fontFamily: 'var(--font-mono)', cursor: 'pointer', transition: 'color 0.1s' }}>{it}</div>
      ))}
      <div style={{ height: ITEM_H * PAD }} />
    </div>
  )
}

export default function DrumDatePicker({ value, min, onChange, placeholder = 'Set date' }: { value: string; min?: string; onChange: (iso: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const base = value ? new Date(value + 'T00:00:00') : new Date()
  const [y, setY] = useState(base.getFullYear())
  const [m, setM] = useState(base.getMonth())
  const [d, setD] = useState(base.getDate())

  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h)
  }, [open])

  const thisYear = new Date().getFullYear()
  const years = Array.from({ length: 3 }, (_, i) => thisYear + i)
  const dim = daysInMonth(y, m)
  const days = Array.from({ length: dim }, (_, i) => String(i + 1).padStart(2, '0'))
  const clampedD = Math.min(d, dim)

  const apply = useCallback((ny: number, nm: number, nd: number) => {
    const dd = Math.min(nd, daysInMonth(ny, nm))
    onChange(iso(ny, nm, dd))
  }, [onChange])

  const fmt = (v: string) => { if (!v) return placeholder; const dt = new Date(v + 'T00:00:00'); return dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) }
  const disabledByMin = (yy: number, mm: number, dd: number) => min ? iso(yy, mm, dd) < min : false

  return (
    <div ref={wrap} style={{ position: 'relative' as const, display: 'inline-flex' }}>
      <button onClick={() => setOpen(o => !o)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: value ? 'var(--ink)' : 'var(--ink-3)', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>
        <Calendar size={13} style={{ color: 'var(--ink-3)' }} />
        <span style={{ fontFamily: value ? 'var(--font-mono)' : 'var(--font-sans)' }}>{fmt(value)}</span>
      </button>
      {open && (
        <div style={{ position: 'absolute' as const, top: '100%', left: 0, marginTop: 4, zIndex: 70, background: 'var(--panel)', border: '1px solid var(--line-2)', borderRadius: 12, boxShadow: 'var(--shadow-md)', padding: 12, width: 230 }}>
          <div style={{ position: 'relative' as const, display: 'flex', justifyContent: 'center', gap: 4 }}>
            {/* centre selection band */}
            <div style={{ position: 'absolute' as const, top: ITEM_H * PAD, left: 0, right: 0, height: ITEM_H, background: 'var(--accent-soft)', borderRadius: 8, pointerEvents: 'none' as const }} />
            <Wheel items={days} index={clampedD - 1} width={54} onChange={i => { const nd = i + 1; setD(nd); apply(y, m, nd) }} />
            <Wheel items={MONTHS} index={m} width={70} onChange={i => { setM(i); apply(y, i, clampedD) }} />
            <Wheel items={years.map(String)} index={Math.max(0, years.indexOf(y))} width={70} onChange={i => { const ny = years[i]; setY(ny); apply(ny, m, clampedD) }} />
          </div>
          <button onClick={() => setOpen(false)} disabled={disabledByMin(y, m, clampedD)}
            style={{ width: '100%', marginTop: 10, padding: '8px', borderRadius: 8, border: 'none', background: disabledByMin(y, m, clampedD) ? 'var(--bg2)' : 'var(--accent-solid)', color: disabledByMin(y, m, clampedD) ? 'var(--ink-3)' : '#fff', fontWeight: 600, fontSize: 13, cursor: disabledByMin(y, m, clampedD) ? 'default' : 'pointer' }}>
            {disabledByMin(y, m, clampedD) ? 'Before earliest date' : 'Done'}
          </button>
        </div>
      )}
    </div>
  )
}
