'use client'
import { useRef, useEffect, useState, useMemo } from 'react'

const ITEM_H = 36
const PAD = 2   // rows of padding above/below the centre band

function Wheel({ items, index, onChange, width, align = 'center' }: { items: string[]; index: number; onChange: (i: number) => void; width: number; align?: 'center' | 'left' }) {
  const ref = useRef<HTMLDivElement>(null)
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => { if (ref.current) ref.current.scrollTop = index * ITEM_H }, [index])
  const onScroll = () => {
    const el = ref.current; if (!el) return
    if (settle.current) clearTimeout(settle.current)
    settle.current = setTimeout(() => {
      const i = Math.max(0, Math.min(items.length - 1, Math.round(el.scrollTop / ITEM_H)))
      el.scrollTo({ top: i * ITEM_H, behavior: 'smooth' })
      if (i !== index) onChange(i)
    }, 90)
  }
  return (
    <div ref={ref} onScroll={onScroll} className="no-scrollbar"
      style={{ width, height: ITEM_H * (PAD * 2 + 1), overflowY: 'auto' as const, scrollSnapType: 'y mandatory' as const, position: 'relative' as const }}>
      <div style={{ height: ITEM_H * PAD }} />
      {items.map((it, i) => {
        const sel = i === index
        return (
          <div key={i} onClick={() => { ref.current?.scrollTo({ top: i * ITEM_H, behavior: 'smooth' }); onChange(i) }}
            style={{ height: ITEM_H, display: 'flex', alignItems: 'center', justifyContent: align === 'left' ? 'flex-start' : 'center', paddingLeft: align === 'left' ? 6 : 0, scrollSnapAlign: 'center' as const, cursor: 'pointer',
              fontSize: sel ? 17 : 14, fontWeight: sel ? 600 : 400, fontFamily: 'var(--font-mono)',
              color: sel ? 'var(--accent)' : 'var(--text3)', transition: 'font-size 0.12s, color 0.12s' }}>{it}</div>
        )
      })}
      <div style={{ height: ITEM_H * PAD }} />
    </div>
  )
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const daysIn = (y: number, m: number) => new Date(y, m + 1, 0).getDate()

// Refined drum-wheel date picker. value/onChange are ISO 'YYYY-MM-DD'. Cannot pick a future date.
export default function WheelDatePicker({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const today = useMemo(() => new Date(), [])
  const init = value ? new Date(value + 'T00:00:00') : today
  const [y, setY] = useState(init.getFullYear())
  const [m, setM] = useState(init.getMonth())
  const [d, setD] = useState(init.getDate())

  const years = useMemo(() => { const cur = today.getFullYear(); return [cur - 1, cur, cur + 1].map(String) }, [today])
  const yIdx = years.indexOf(String(y))
  const days = useMemo(() => Array.from({ length: daysIn(y, m) }, (_, i) => String(i + 1)), [y, m])

  const clampFuture = (yy: number, mm: number, dd: number) => {
    const picked = new Date(yy, mm, dd)
    if (picked.getTime() > new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) {
      return { yy: today.getFullYear(), mm: today.getMonth(), dd: today.getDate() }
    }
    return { yy, mm, dd }
  }
  const commit = (yy: number, mm: number, dd: number) => {
    const maxD = daysIn(yy, mm); if (dd > maxD) dd = maxD
    const c = clampFuture(yy, mm, dd)
    setY(c.yy); setM(c.mm); setD(c.dd)
    onChange(`${c.yy}-${String(c.mm + 1).padStart(2, '0')}-${String(c.dd).padStart(2, '0')}`)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
      <div style={{ display: 'flex', gap: 6, position: 'relative' as const, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
        <div style={{ position: 'absolute' as const, left: 8, right: 8, top: '50%', transform: 'translateY(-50%)', height: ITEM_H, background: 'var(--accent-bg)', borderRadius: 8, zIndex: 0, pointerEvents: 'none' as const }} />
        <div style={{ display: 'flex', gap: 6, position: 'relative' as const, zIndex: 1, width: '100%' }}>
          <Wheel items={days} index={d - 1} onChange={i => commit(y, m, i + 1)} width={56} />
          <Wheel items={MONTHS} index={m} onChange={i => commit(y, i, d)} width={64} />
          <Wheel items={years} index={yIdx < 0 ? 1 : yIdx} onChange={i => commit(Number(years[i]), m, d)} width={72} />
        </div>
      </div>
    </div>
  )
}
