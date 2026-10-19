'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { OverviewPayload, OvRange } from '@/lib/overviewMetrics'

// Owner Overview — one screen across production → warehouse → dispatch → after-ship.
// Light mode only (explicit palette, independent of the app theme vars). Semantic
// colour only; brand orange #C2410C on actions/links. Pulls /api/overview.

const C = {
  bg: '#F6F5F2', card: '#FFFFFF', border: '#E4E2DD', hair: '#EEECE7', fill: '#FBFAF8',
  ink: '#1C1B19', ink2: '#4A4843', mut: '#6B6862', accent: '#C2410C', accentHover: '#9A3412',
  red: '#B42318', redBg: '#FDECEA', amb: '#B45309', ambBg: '#FEF3E2', grn: '#15803D', grnBg: '#E8F5EC',
  neu: '#4A4843', neuBg: '#F0EFEB', bar: '#1C1B19', barTrack: '#EEECE7',
}
const SANS = "'IBM Plex Sans', system-ui, sans-serif"
const MONO = "'IBM Plex Mono', ui-monospace, monospace"

const pill = (tone: 'red' | 'amb' | 'grn' | 'neu'): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', height: 22, padding: '0 8px', borderRadius: 999,
  fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
  background: tone === 'red' ? C.redBg : tone === 'amb' ? C.ambBg : tone === 'grn' ? C.grnBg : C.neuBg,
  color: tone === 'red' ? C.red : tone === 'amb' ? C.amb : tone === 'grn' ? C.grn : C.neu,
})
const card: React.CSSProperties = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 12 }
const lbl: React.CSSProperties = { fontSize: 12, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase', color: C.mut }
const num: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }

function fmt(n: number | null | undefined): string {
  if (n == null) return '—'
  return n.toLocaleString('en-IN')
}

export default function OverviewClient({ onNavigate }: { onNavigate?: (tabKey: string) => void }) {
  const [range, setRange] = useState<OvRange>('today')
  const [data, setData] = useState<OverviewPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastLoaded, setLastLoaded] = useState<Date | null>(null)

  const load = useCallback(async (r: OvRange) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/overview?range=${r}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(res.status === 403 ? 'You don’t have access to the owner overview.' : `Failed to load (${res.status})`)
      setData(await res.json()); setLastLoaded(new Date())
    } catch (e) { setError((e as Error).message) }
    setLoading(false)
  }, [])

  useEffect(() => { void load(range) }, [range, load])
  useEffect(() => {
    const id = setInterval(() => void load(range), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [range, load])

  const nav = (key: string) => (e: React.MouseEvent) => { e.preventDefault(); onNavigate?.(key) }
  const link: React.CSSProperties = { color: C.accent, textDecoration: 'none', fontWeight: 500 }

  const todayLabel = useMemo(() => {
    const d = data ? new Date(`${data.istDate}T00:00:00+05:30`) : new Date()
    return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
  }, [data])

  return (
    <div style={{ fontFamily: SANS, color: C.ink, background: C.bg, minHeight: '100%', boxSizing: 'border-box', padding: '28px 20px 56px', margin: '-16px -16px 0' }}>
      <style>{`.ovlink:hover{color:${C.accentHover}!important}`}</style>
      <div style={{ maxWidth: 1360, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Header */}
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={lbl}>DispatchLens · Owner</div>
            <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, letterSpacing: '-.01em' }}>{todayLabel}</h1>
            <div style={{ fontSize: 14, color: C.mut }}>
              {lastLoaded ? `Live as of ${lastLoaded.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}` : 'Loading…'} · production, warehouse, dispatch and after-ship in one view
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div role="group" aria-label="Range" style={{ display: 'flex', background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: 3 }}>
              {(['today', '7d', '30d'] as OvRange[]).map(r => (
                <button key={r} onClick={() => setRange(r)} style={{
                  height: 36, padding: '0 14px', border: 0, borderRadius: 8, cursor: 'pointer',
                  background: range === r ? C.ink : 'transparent', color: range === r ? '#fff' : C.ink2,
                  font: `${range === r ? 600 : 500} 13px ${SANS}`,
                }}>{r === 'today' ? 'Today' : r === '7d' ? '7 days' : '30 days'}</button>
              ))}
            </div>
            <button onClick={() => void load(range)} disabled={loading} style={{
              height: 44, padding: '0 16px', border: 0, borderRadius: 10, background: C.accent, color: '#fff',
              font: `600 14px ${SANS}`, cursor: loading ? 'default' : 'pointer', opacity: loading ? 0.7 : 1,
            }}>{loading ? 'Refreshing…' : 'Refresh'}</button>
          </div>
        </header>

        {error && <div style={{ ...card, padding: 16, color: C.red, background: C.redBg, borderColor: '#F3C9C3' }}>{error}</div>}
        {!data && !error && <div style={{ ...card, padding: 48, textAlign: 'center', color: C.mut }}>Loading overview…</div>}

        {data && <>
          {/* A. Today's dispatch */}
          <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) repeat(4,minmax(0,1fr))', gap: 12 }} className="ov-a">
            <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={lbl}>Today&apos;s dispatch</span><span style={pill('amb')}>Due today</span></div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ ...num, fontSize: 44, fontWeight: 600, lineHeight: 1 }}>{fmt(data.dispatch.dispatchedToday)}</span>
                <span style={{ ...num, fontSize: 20, color: C.mut }}>/ {fmt(data.dispatch.goingToday)} orders out</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {data.dispatch.couriers.map(c => {
                  const pct = c.planned ? Math.min(100, Math.round((c.dispatched / c.planned) * 100)) : 0
                  return (
                    <div key={c.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span style={{ fontWeight: 500 }}>{c.name}</span>
                        <span style={{ ...num, color: C.mut }}>{c.dispatched} / {c.planned}</span>
                      </div>
                      <div style={{ height: 8, background: C.barTrack, borderRadius: 4, overflow: 'hidden' }}><div style={{ width: `${pct}%`, height: '100%', background: C.bar }} /></div>
                    </div>
                  )
                })}
              </div>
            </div>
            {[
              { l: 'Critical', v: data.dispatch.critical, c: C.red, s: 'at or past dispatch-by' },
              { l: 'Undecided', v: data.dispatch.undecided, c: C.amb, s: 'not planned yet' },
              { l: 'Picked, not out', v: data.dispatch.pickedNotDispatched, c: C.amb, s: 'pieces on the floor' },
              { l: 'On hold', v: data.dispatch.onHold, c: C.ink, s: `${data.dispatch.slipped} slipped · ${data.dispatch.unmapped} unmapped` },
            ].map(t => (
              <div key={t.l} style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8 }}>
                <span style={lbl}>{t.l}</span>
                <span style={{ ...num, fontSize: 36, fontWeight: 600, color: t.c }}>{fmt(t.v)}</span>
                <span style={{ fontSize: 13, color: C.mut }}>{t.s}</span>
              </div>
            ))}
          </section>

          {/* B. Pipeline */}
          <section style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span style={lbl}>Pipeline · frame to doorstep</span>
                <span style={{ fontSize: 13, color: C.mut }}>Stock at each stage now · movement today underneath · tap a stage to open its tab</span>
              </div>
              <div style={{ display: 'flex', gap: 6 }}><span style={pill('neu')}>Production</span><span style={pill('neu')}>Warehouse</span><span style={pill('neu')}>Dispatch</span></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap: 8 }} className="ov-pipeline">
              {data.pipeline.map(s => (
                <a key={s.name} href="#" onClick={nav(s.tab)} className="ovlink" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 14, borderRadius: 10, border: `1px solid ${C.border}`, background: C.fill, color: C.ink, minHeight: 132, boxSizing: 'border-box', textDecoration: 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 12, color: C.mut, fontWeight: 500 }}>{s.step}</span>
                    {s.flag && <span style={{ ...pill('red'), height: 18, fontSize: 11 }}>Data gap</span>}
                  </div>
                  <span style={{ fontSize: 15, fontWeight: 600 }}>{s.name}</span>
                  <span style={{ ...num, fontSize: 28, fontWeight: 600, lineHeight: 1.1 }}>{s.count == null ? '—' : fmt(s.count)}</span>
                  <span style={{ fontSize: 12, color: C.ink2 }}>{s.today}</span>
                  <span style={{ fontSize: 11, color: C.mut, marginTop: 'auto' }}>{s.tab.replace('wh:', '')} →</span>
                </a>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 8, background: C.redBg, color: '#7A1B12', fontSize: 13 }}>
              <span style={{ fontWeight: 600 }}>Picked data gap:</span>
              <span>frame pieces never close out when they&apos;re packed, so &quot;Picked&quot; only grows. Needs a frame-barcode → packed-unit link before this stage reads true. Today&apos;s picked movement is still correct.</span>
            </div>
          </section>

          {/* C + D */}
          <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0,5fr) minmax(0,7fr)', gap: 20 }} className="ov-cd">
            {/* Needs you */}
            <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={lbl}>Needs you</span><span style={{ ...num, fontSize: 13, color: C.mut }}>{data.issues.length} items · worst first</span></div>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {data.issues.length === 0 && <div style={{ padding: '16px 0', color: C.grn, fontSize: 14 }}>All clear — nothing needs attention.</div>}
                {data.issues.map((i, idx) => (
                  <a key={idx} href="#" onClick={nav(i.tab)} className="ovlink" style={{ display: 'grid', gridTemplateColumns: '74px minmax(0,1fr) auto', gap: 12, alignItems: 'center', padding: '11px 0', borderTop: `1px solid ${C.hair}`, color: C.ink, minHeight: 44, textDecoration: 'none' }}>
                    <span style={{ ...pill(i.tone), justifyContent: 'center' }}>{i.sev}</span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <span style={{ fontSize: 14, fontWeight: 500 }}>{i.title}</span>
                      <span style={{ fontSize: 12, color: C.mut }}>{i.sub}</span>
                    </span>
                    <span style={{ fontSize: 12, color: C.accent, fontWeight: 500, whiteSpace: 'nowrap' }}>{i.tab.replace('wh:', '')} →</span>
                  </a>
                ))}
              </div>
            </div>

            {/* Right column: shortfall + production */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={lbl}>Today&apos;s shortfall · to pack</span>
                  {data.shortfall.skus > 0 ? <span style={pill('red')}>{data.shortfall.pcs} pcs · {data.shortfall.skus} SKUs</span> : <span style={pill('grn')}>Covered</span>}
                </div>
                {data.shortfall.rows.length === 0 ? (
                  <div style={{ fontSize: 13, color: C.mut }}>Everything due today is in stock.</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px 72px 72px', fontSize: 13 }}>
                    {['SKU', 'Needed', 'In stock', 'To pack'].map((h, i) => <span key={h} style={{ color: C.mut, padding: '6px 0', textAlign: i === 0 ? 'left' : 'right' }}>{h}</span>)}
                    {data.shortfall.rows.slice(0, 8).map(r => (
                      <div key={r.sku} style={{ display: 'contents' }}>
                        <span style={{ fontFamily: MONO, padding: '8px 0', borderTop: `1px solid ${C.hair}`, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.sku} <span style={{ fontFamily: SANS, color: C.mut }}>{r.product}</span></span>
                        <span style={{ ...num, padding: '8px 0', borderTop: `1px solid ${C.hair}`, textAlign: 'right' }}>{r.needed}</span>
                        <span style={{ ...num, padding: '8px 0', borderTop: `1px solid ${C.hair}`, textAlign: 'right' }}>{r.inStock}</span>
                        <span style={{ ...num, padding: '8px 0', borderTop: `1px solid ${C.hair}`, textAlign: 'right', color: C.red, fontWeight: 600 }}>{r.toPack}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={lbl}>Production vs dispatch · last 14 days</span>
                  <div style={{ display: 'flex', gap: 14, fontSize: 12, color: C.ink2, flexWrap: 'wrap' }}>
                    {[['Inward', '#9C9890'], ['Coated', '#5E5A53'], ['Packed', '#1C1B19']].map(([t, col]) => (
                      <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 10, height: 10, borderRadius: 2, background: col }} />{t}</span>
                    ))}
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 14, height: 2, background: C.accent }} />Dispatched</span>
                  </div>
                </div>
                <Chart14 chart={data.chart} />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12, fontSize: 13 }} className="ov-prod">
                  {[
                    { l: 'Inward today', v: `${fmt(data.production.inwardToday)} frames`, b: data.production.inwardBySupplier },
                    { l: 'Coated today', v: `${fmt(data.production.coatedToday)} pcs`, b: data.production.coatedByShape },
                    { l: 'Picked today', v: `${fmt(data.production.pickedToday)} pcs`, b: data.production.pickedByShape },
                  ].map(x => (
                    <div key={x.l} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ color: C.mut }}>{x.l}</span>
                      <span style={{ ...num, fontSize: 18, fontWeight: 600 }}>{x.v}</span>
                      <span style={{ color: C.mut, fontSize: 12 }}>{breakdown(x.b)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* E. After-ship */}
          <section style={{ display: 'grid', gridTemplateColumns: 'minmax(0,2fr) repeat(3,minmax(0,1fr))', gap: 12 }} className="ov-e">
            <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={lbl}>Shipped · last 7 days</span><span style={{ ...num, fontSize: 13, color: C.mut }}>{fmt(data.afterShip.shipped)} orders</span></div>
              <div style={{ display: 'flex', height: 14, borderRadius: 4, overflow: 'hidden', gap: 2 }}>
                {data.afterShip.buckets.map(b => { const w = data.afterShip.shipped ? (b.count / data.afterShip.shipped) * 100 : 0; return w > 0 ? <div key={b.label} style={{ width: `${w}%`, background: b.color }} /> : null })}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8, fontSize: 13 }}>
                {data.afterShip.buckets.map(b => (
                  <div key={b.label} style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ color: C.mut }}>{b.label}</span>
                    <span style={{ ...num, fontSize: 18, fontWeight: 600, color: b.label === 'Delivered' ? C.grn : b.label === 'Unknown' ? C.amb : C.ink }}>{fmt(b.count)}</span>
                  </div>
                ))}
              </div>
            </div>
            <StatCard label="OTDR · Amazon" value={data.afterShip.otdr == null ? '[OTDR %]' : `${data.afterShip.otdr}%`} sub="10-day forecast · wiring in next" />
            <StatCard label="Delayed" value={fmt(data.afterShip.delayed)} valueColor={C.red} sub={`oldest ${data.afterShip.delayedOldestDays ?? 0}d · ${data.afterShip.remindersSent} reminders`} />
            <StatCard label="Refunds pending" value={`₹${fmt(data.afterShip.refundsPendingAmt)}`} sub={`${data.afterShip.refundsPendingCnt} pending`} />
          </section>

          {/* F. Team + stock */}
          <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 12 }} className="ov-f">
            <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <span style={lbl}>Team today</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
                {data.team.picksByPicker.slice(0, 4).map(p => (
                  <div key={p.name} style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Picks · {p.name}</span><span style={{ ...num, fontWeight: 600 }}>{p.count}</span></div>
                ))}
                {data.team.picksByPicker.length === 0 && <div style={{ color: C.mut, fontSize: 13 }}>No picks yet today</div>}
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Customer calls (CallLens)</span><span style={{ ...num, fontWeight: 600 }}>{data.team.callsToday}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Dispatch scans</span><span style={{ ...num, fontWeight: 600 }}>{data.team.dispatchScansToday}</span></div>
              </div>
            </div>
            <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={lbl}>Packed stock</span>{data.team.packedLowSkus > 0 && <span style={pill('amb')}>{data.team.packedLowSkus} low</span>}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ ...num, fontSize: 32, fontWeight: 600 }}>{fmt(data.team.packedStock)}</span><span style={{ fontSize: 14, color: C.mut }}>units · {data.team.packedStockSkus} SKUs</span></div>
              <span style={{ fontSize: 13, color: C.mut }}>{data.team.packedAwaitingStockIn} packed awaiting stock-in</span>
            </div>
            <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><span style={lbl}>Money · settlements</span><span style={pill('neu')}>Coming soon</span></div>
              <div style={{ ...num, fontSize: 32, fontWeight: 600, color: C.mut }}>[₹ RECEIVED]</div>
              <span style={{ fontSize: 13, color: C.mut }}>vs expected from Recon · phase 2</span>
            </div>
          </section>
        </>}
      </div>

      <style>{`
        @media (max-width: 1000px){
          .ov-a{grid-template-columns:repeat(2,minmax(0,1fr))!important}
          .ov-cd{grid-template-columns:minmax(0,1fr)!important}
          .ov-e{grid-template-columns:repeat(2,minmax(0,1fr))!important}
          .ov-f{grid-template-columns:minmax(0,1fr)!important}
        }
        @media (max-width: 560px){
          .ov-a,.ov-e{grid-template-columns:minmax(0,1fr)!important}
          .ov-pipeline{grid-template-columns:repeat(2,minmax(0,1fr))!important}
          .ov-prod{grid-template-columns:minmax(0,1fr)!important}
        }
      `}</style>
    </div>
  )
}

function StatCard({ label, value, sub, valueColor }: { label: string; value: string; sub: string; valueColor?: string }) {
  return (
    <div style={{ ...card, padding: 20, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: 8 }}>
      <span style={lbl}>{label}</span>
      <span style={{ ...num, fontSize: 32, fontWeight: 600, color: valueColor || C.ink }}>{value}</span>
      <span style={{ fontSize: 13, color: C.mut }}>{sub}</span>
    </div>
  )
}

function breakdown(b: Record<string, number>): string {
  const parts = Object.entries(b).sort((a, c) => c[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`)
  return parts.length ? parts.join(' · ') : '—'
}

function Chart14({ chart }: { chart: OverviewPayload['chart'] }) {
  if (!chart || chart.length === 0) {
    return (
      <div style={{ height: 180, border: `1px dashed #D6D3CC`, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.ink2, fontSize: 13 }}>
        Fills in once the daily snapshot job starts recording
      </div>
    )
  }
  const max = Math.max(1, ...chart.map(d => Math.max(d.inward_today, d.coated_today, d.packed_today, d.dispatched_today)))
  const cols = ['#9C9890', '#5E5A53', '#1C1B19']
  return (
    <div style={{ height: 180, border: `1px solid ${C.border}`, borderRadius: 8, display: 'flex', alignItems: 'flex-end', gap: 6, padding: 16, boxSizing: 'border-box' }}>
      {chart.map(d => (
        <div key={d.snap_date} style={{ flex: 1, display: 'flex', gap: 2, alignItems: 'flex-end', height: '100%' }} title={`${d.snap_date}: inward ${d.inward_today} · coated ${d.coated_today} · packed ${d.packed_today} · dispatched ${d.dispatched_today}`}>
          {[d.inward_today, d.coated_today, d.packed_today].map((v, i) => (
            <div key={i} style={{ flex: 1, background: cols[i], borderRadius: '2px 2px 0 0', height: `${Math.round((v / max) * 100)}%` }} />
          ))}
        </div>
      ))}
    </div>
  )
}
