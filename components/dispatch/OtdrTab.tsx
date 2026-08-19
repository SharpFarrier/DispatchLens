'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { detectPlatform } from '@/lib/skuResolver'
import { RefreshCw } from 'lucide-react'

// v1: DELIVERED Amazon orders only (all courier partners). On-time = delivered on/before EDD.
// OTDR window = 30 days by EDD (promise_date), ending 10 days before the target date.
// In-transit orders entering the window as it shifts are deferred (a later refinement).

interface Delivered { promise: string; delivered: string; onTime: boolean }
const TARGET = 97

const IST = 5.5 * 3600 * 1000
const istDateStr = (d: Date) => new Date(d.getTime() + IST).toISOString().slice(0, 10)
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const fmtDay = (iso: string) => { const d = new Date(iso + 'T00:00:00Z'); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) }

export default function OtdrTab() {
  const supabase = createClient()
  const [orders, setOrders] = useState<Delivered[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [loadedAt, setLoadedAt] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const acc: Delivered[] = []
      const pageSize = 1000
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase.from('dispatch_orders')
          .select('order_id, promise_date, delivered_at')
          .eq('tracking_status', 'delivered')
          .not('promise_date', 'is', null)
          .not('delivered_at', 'is', null)
          .range(from, from + pageSize - 1)
        if (error) throw error
        const rows = (data || []) as { order_id: string; promise_date: string; delivered_at: string }[]
        for (const r of rows) {
          if (detectPlatform(r.order_id) !== 'Amazon') continue
          const promise = String(r.promise_date).slice(0, 10)
          const delivered = istDateStr(new Date(r.delivered_at))
          if (!/^\d{4}-\d{2}-\d{2}$/.test(promise)) continue
          acc.push({ promise, delivered, onTime: delivered <= promise })
        }
        if (rows.length < pageSize) break
      }
      setOrders(acc)
      setLoadedAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))
    } catch (e) { setErr((e as Error).message) }
    setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const projection = useMemo(() => {
    const today = istDateStr(new Date())
    const out: { d: number; date: string; start: string; end: string; total: number; onTime: number; otdr: number | null }[] = []
    for (let d = 0; d <= 10; d++) {
      const target = addDays(today, d)
      const end = addDays(target, -10)
      const start = addDays(end, -29)
      let total = 0, onTime = 0
      for (const o of orders) if (o.promise >= start && o.promise <= end) { total++; if (o.onTime) onTime++ }
      out.push({ d, date: target, start, end, total, onTime, otdr: total ? +(onTime / total * 100).toFixed(2) : null })
    }
    return out
  }, [orders])

  const todayRow = projection[0]
  const vals = projection.map(p => p.otdr).filter((v): v is number => v != null)
  const minV = Math.min(TARGET - 1, ...(vals.length ? vals : [TARGET]))
  const maxV = Math.max(TARGET + 1, ...(vals.length ? vals : [TARGET]))
  const colorFor = (v: number | null) => v == null ? 'var(--text3)' : v >= TARGET ? 'var(--dispatched)' : 'var(--critical)'

  // Chart geometry
  const W = 640, H = 180, padL = 40, padR = 16, padT = 16, padB = 28
  const x = (i: number) => padL + (i / 10) * (W - padL - padR)
  const y = (v: number) => padT + (1 - (v - minV) / (maxV - minV || 1)) * (H - padT - padB)
  const linePts = projection.map((p, i) => p.otdr == null ? null : `${x(i)},${y(p.otdr)}`).filter(Boolean).join(' ')

  const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10 }

  return (
    <div style={{ maxWidth: 980, display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 4px' }}>Delivery Performance — OTDR forecast</h2>
          <p style={{ fontSize: 12.5, color: 'var(--text3)', margin: 0, lineHeight: 1.5, maxWidth: 720 }}>
            Projected On-Time Delivery Rate for the next 10 days, as the 30-day window (bucketed by promised delivery date, ending 10 days before each date) rolls forward. Amazon orders, all courier partners. <strong>v1 counts delivered orders only</strong> — orders still in transit that will enter the window are not yet included.
          </p>
        </div>
        <button onClick={() => void load()} disabled={loading} style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: loading ? 'default' : 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' as const }}>
          <RefreshCw size={13} style={loading ? { animation: 'spin 1s linear infinite' } : undefined} /> {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {err && <div style={{ borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: '1px solid #fecaca', background: 'var(--critical-bg)', color: 'var(--critical)' }}>Load failed: {err}</div>}

      {loading && !orders.length ? (
        <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading delivered orders…</div>
      ) : (<>
        {/* Today hero + range */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' as const }}>
          <div style={{ ...card, padding: 18, minWidth: 220 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.5, color: 'var(--text3)' }}>Today&apos;s OTDR (delivered)</div>
            <div style={{ fontSize: 40, fontWeight: 800, fontFamily: 'DM Mono', color: colorFor(todayRow?.otdr ?? null), lineHeight: 1.1, marginTop: 4 }}>{todayRow?.otdr != null ? todayRow.otdr + '%' : '—'}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{todayRow ? `${todayRow.onTime.toLocaleString('en-IN')} on-time / ${todayRow.total.toLocaleString('en-IN')} delivered` : ''}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Window {todayRow ? `${fmtDay(todayRow.start)} – ${fmtDay(todayRow.end)}` : ''}</div>
          </div>
          <div style={{ ...card, padding: 18, minWidth: 200 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.5, color: 'var(--text3)' }}>In 10 days (projected)</div>
            <div style={{ fontSize: 40, fontWeight: 800, fontFamily: 'DM Mono', color: colorFor(projection[10]?.otdr ?? null), lineHeight: 1.1, marginTop: 4 }}>{projection[10]?.otdr != null ? projection[10].otdr + '%' : '—'}</div>
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>Target {TARGET}%+</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>Window {projection[10] ? `${fmtDay(projection[10].start)} – ${fmtDay(projection[10].end)}` : ''}</div>
          </div>
        </div>

        {/* Trend chart */}
        <div style={{ ...card, padding: '16px 12px' }}>
          <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
            {/* target line */}
            <line x1={padL} x2={W - padR} y1={y(TARGET)} y2={y(TARGET)} stroke="var(--critical)" strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
            <text x={W - padR} y={y(TARGET) - 4} textAnchor="end" fontSize="10" fill="var(--critical)">Target {TARGET}%</text>
            {/* y ticks */}
            {[minV, (minV + maxV) / 2, maxV].map((v, i) => (
              <text key={i} x={padL - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="var(--text3)">{v.toFixed(1)}</text>
            ))}
            {/* line */}
            {linePts && <polyline points={linePts} fill="none" stroke="var(--accent)" strokeWidth="2" />}
            {/* points */}
            {projection.map((p, i) => p.otdr == null ? null : (
              <g key={i}>
                <circle cx={x(i)} cy={y(p.otdr)} r="3.5" fill={colorFor(p.otdr)} />
                <text x={x(i)} y={H - padB + 16} textAnchor="middle" fontSize="9" fill="var(--text3)">{p.d === 0 ? 'Today' : `+${p.d}`}</text>
              </g>
            ))}
          </svg>
        </div>

        {/* Detail table */}
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12.5, minWidth: 560 }}>
              <thead><tr>
                {['Date', 'EDD window', 'On-time', 'Delivered', 'OTDR', 'vs today'].map((h, i) => (
                  <th key={h} style={{ padding: '9px 12px', textAlign: i >= 2 ? 'right' as const : 'left' as const, fontSize: 11, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text3)', background: 'var(--bg2)', whiteSpace: 'nowrap' as const }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {projection.map(p => {
                  const delta = p.otdr != null && todayRow?.otdr != null ? +(p.otdr - todayRow.otdr).toFixed(2) : null
                  return (
                    <tr key={p.d} style={{ borderTop: '1px solid var(--border)', background: p.d === 0 ? 'var(--bg2)' : undefined }}>
                      <td style={{ padding: '9px 12px', fontWeight: p.d === 0 ? 700 : 400 }}>{p.d === 0 ? 'Today' : `+${p.d}d`} <span style={{ color: 'var(--text3)', fontWeight: 400 }}>· {fmtDay(p.date)}</span></td>
                      <td style={{ padding: '9px 12px', color: 'var(--text2)', fontFamily: 'DM Mono', fontSize: 11 }}>{fmtDay(p.start)} – {fmtDay(p.end)}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono' }}>{p.onTime.toLocaleString('en-IN')}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{p.total.toLocaleString('en-IN')}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: colorFor(p.otdr) }}>{p.otdr != null ? p.otdr + '%' : '—'}</td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontSize: 11, color: delta == null ? 'var(--text3)' : delta > 0 ? 'var(--dispatched)' : delta < 0 ? 'var(--critical)' : 'var(--text3)' }}>{delta == null ? '—' : delta === 0 ? '±0' : (delta > 0 ? '+' : '') + delta}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 11, color: 'var(--text3)' }}>
            {orders.length.toLocaleString('en-IN')} delivered Amazon orders loaded{loadedAt ? ` · ${loadedAt}` : ''}. On-time = delivered on or before the promised delivery date.
          </div>
        </div>
      </>)}
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}
