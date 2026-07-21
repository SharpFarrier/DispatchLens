'use client'
import { useState, useEffect, useMemo, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Package, Search, AlertTriangle } from 'lucide-react'
import FulfillmentWaterfall from './FulfillmentWaterfall'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }
const OWNER_EMAIL = 'adityaramnani91581@gmail.com'

// Product images hosted in the barcode-picker repo (raw GitHub) — same source as
// the Generate-barcodes picker, so thumbnails match everywhere. Filenames are the
// product name, Capitalized except base/oslo which are lowercase. Products absent
// here (Linea Grey, Rollease, Spacio) fall back to a placeholder tile.
const IMG_BASE = 'https://raw.githubusercontent.com/SharpFarrier/barcode-picker/main/images'
const LOWER_IMG = ['Base', 'Oslo']
const KNOWN_IMG = ['Atlas', 'Aura', 'Avon', 'Base', 'Boston', 'Duke', 'Elvo', 'Eva', 'Jasper', 'Lizon', 'Luvo', 'Nesto', 'Nexon', 'Nova', 'Oslo', 'Xyra']
function productImage(product: string): string | null {
  if (!KNOWN_IMG.includes(product)) return null
  const file = LOWER_IMG.includes(product) ? product.toLowerCase() : product
  return `${IMG_BASE}/${encodeURIComponent(file)}.png`
}

interface PackedUnitRow { sku: string; status: string }
interface PackedSkuRow { sku: string; descr: string | null; product: string }
interface InvRow {
  sku: string; descr: string; product: string
  packed: number; stocked: number; in_dispatch: number; dispatched: number; rto: number
  low: boolean
}

type SortKey = 'descr' | 'stocked' | 'packed' | 'in_dispatch' | 'dispatched' | 'rto'

export default function InventoryTab() {
  const supabase = createClient()
  const [units, setUnits] = useState<PackedUnitRow[]>([])
  const [skus, setSkus] = useState<PackedSkuRow[]>([])
  const [loading, setLoading] = useState(true)
  const [threshold, setThreshold] = useState(5)
  // Run-rate config: min orders/day to count a real dispatch day, and target-days horizon.
  const [rrThreshold, setRrThreshold] = useState(10)
  const [targetDays, setTargetDays] = useState(20)
  const [dispatch30d, setDispatch30d] = useState<{ sku: string; qty: number; date: string }[]>([])
  // Rate/day is sensitive — only users with the 'Users' (can_users) admin permission see it.
  const [isAdmin, setIsAdmin] = useState(false)
  const [search, setSearch] = useState('')
  const [lowOnly, setLowOnly] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('stocked')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  // Expandable barcode drilldown — fetched lazily per SKU on first expand.
  const [expanded, setExpanded] = useState<string | null>(null)
  const [skuBarcodes, setSkuBarcodes] = useState<Record<string, { barcode: string; status: string }[]>>({})
  const [loadingSku, setLoadingSku] = useState<string | null>(null)

  const toggleExpand = async (sku: string) => {
    if (expanded === sku) { setExpanded(null); return }
    setExpanded(sku)
    if (!skuBarcodes[sku]) {
      setLoadingSku(sku)
      const rows = await fetchAllRows<{ barcode: string; status: string }>((from, to) =>
        supabase.from('packed_units').select('barcode, status').eq('sku', sku).order('seq').order('id', { ascending: false }).range(from, to))
      setSkuBarcodes(prev => ({ ...prev, [sku]: rows }))
      setLoadingSku(null)
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true)
      // packed_units can exceed Supabase's 1000-row cap — page through all rows.
      const allUnits = await fetchAllRows<PackedUnitRow>((from, to) =>
        supabase.from('packed_units').select('sku, status').order('id', { ascending: false }).range(from, to))
      const s = await supabase.from('packed_skus').select('sku, descr, product')
      // Trailing 30 days of dispatches for the run-rate calc.
      const since = new Date(); since.setDate(since.getDate() - 30); since.setHours(0, 0, 0, 0)
      const disp = await fetchAllRows<{ barcode_sku: string; sku: string; qty: number; dispatched_at: string }>((from, to) =>
        supabase.from('dispatch_orders').select('barcode_sku, sku, qty, dispatched_at')
          .eq('is_dispatched', true).gte('dispatched_at', since.toISOString())
          .order('id', { ascending: false }).range(from, to))
      setDispatch30d((disp || []).map(o => ({ sku: o.barcode_sku || o.sku, qty: o.qty || 1, date: (o.dispatched_at || '').slice(0, 10) })).filter(o => o.sku && o.date))
      setUnits(allUnits)
      setSkus((s.data as PackedSkuRow[]) || [])
      // Determine admin (can_users) to gate the Rate/day column.
      const { data: auth } = await supabase.auth.getUser()
      const email = auth?.user?.email
      if (email) {
        if (email.toLowerCase() === OWNER_EMAIL.toLowerCase()) setIsAdmin(true)
        else {
          const { data: acc } = await supabase.from('dispatch_user_access').select('can_users').eq('email', email).maybeSingle()
          setIsAdmin(!!acc?.can_users)
        }
      }
      setLoading(false)
    })()
  }, [supabase])

  const rows = useMemo<InvRow[]>(() => {
    const meta: Record<string, PackedSkuRow> = {}
    skus.forEach(s => { meta[s.sku] = s })
    const map: Record<string, InvRow> = {}
    units.forEach(u => {
      if (!map[u.sku]) map[u.sku] = { sku: u.sku, descr: meta[u.sku]?.descr || u.sku, product: meta[u.sku]?.product || '', packed: 0, stocked: 0, in_dispatch: 0, dispatched: 0, rto: 0, low: false }
      const key = u.status === 'in-dispatch' ? 'in_dispatch' : u.status
      if (key in map[u.sku]) (map[u.sku] as unknown as Record<string, number>)[key]++
    })
    return Object.values(map).map(r => ({ ...r, low: r.stocked <= threshold }))
  }, [units, skus, threshold])

  // Run rate per SKU: pieces over trailing 30d / real dispatch days (dates with
  // >= rrThreshold orders). All pieces count in numerator; only real days divide.
  const runRate = useMemo(() => {
    const ordersPerDate: Record<string, number> = {}
    const piecesBySku: Record<string, number> = {}
    for (const o of dispatch30d) {
      ordersPerDate[o.date] = (ordersPerDate[o.date] || 0) + 1
      piecesBySku[o.sku] = (piecesBySku[o.sku] || 0) + o.qty
    }
    const realDays = Object.values(ordersPerDate).filter(c => c >= rrThreshold).length || 1
    const rateBySku: Record<string, number> = {}
    for (const sku in piecesBySku) rateBySku[sku] = piecesBySku[sku] / realDays
    return { rateBySku, realDays }
  }, [dispatch30d, rrThreshold])

  const totals = useMemo(() => {
    const t = { packed: 0, stocked: 0, in_dispatch: 0, dispatched: 0, rto: 0 }
    rows.forEach(r => { t.packed += r.packed; t.stocked += r.stocked; t.in_dispatch += r.in_dispatch; t.dispatched += r.dispatched; t.rto += r.rto })
    return t
  }, [rows])

  const filtered = useMemo(() => {
    let f = rows
    if (lowOnly) f = f.filter(r => r.low && (r.stocked + r.packed) > 0)
    if (search.trim()) {
      const q = search.toLowerCase()
      f = f.filter(r => r.sku.toLowerCase().includes(q) || r.descr.toLowerCase().includes(q) || r.product.toLowerCase().includes(q))
    }
    const sorted = [...f].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey]
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? cmp : -cmp
    })
    return sorted
  }, [rows, lowOnly, search, sortKey, sortDir])

  const lowCount = rows.filter(r => r.low && (r.stocked + r.packed) > 0).length

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('desc') }
  }

  const th = (label: string, k: SortKey, align: 'left' | 'right' = 'right') => (
    <th onClick={() => toggleSort(k)} style={{ background: 'var(--bg2)', padding: '9px 12px', textAlign: align, color: sortKey === k ? 'var(--accent)' : 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const, cursor: 'pointer', userSelect: 'none' as const }}>
      {label}{sortKey === k ? <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span> : <span style={{ marginLeft: 4, opacity: 0.3 }}>↕</span>}
    </th>
  )

  if (loading) return <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading inventory…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600 }}>Packed Inventory</h1>
        <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'DM Mono' }}>{rows.length} SKUs in stock pool</span>
      </div>

      {/* KPI cards */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const }}>
        {[
          { label: 'In Stock', value: totals.stocked, color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0' },
          { label: 'Packed', value: totals.packed, color: 'var(--accent)', bg: 'var(--accent-bg)', border: 'var(--accent)' },
          { label: 'Dispatched', value: totals.dispatched, color: 'var(--text2)', bg: 'var(--bg2)', border: 'var(--border)' },
        ].map(k => (
          <div key={k.label} style={{ flex: 1, minWidth: 140, padding: '16px 20px', background: k.bg, border: `1px solid ${k.border}`, borderRadius: 8, textAlign: 'center' as const }}>
            <div style={{ fontSize: 30, fontFamily: 'DM Mono', fontWeight: 700, color: k.color, lineHeight: 1 }}>{k.value}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, marginTop: 6, textTransform: 'uppercase' as const, letterSpacing: '0.04em' }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px', flex: 1, minWidth: 180 }}>
          <Search size={13} style={{ color: 'var(--text3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search SKU / product…"
            style={{ border: 'none', background: 'transparent', color: 'var(--text)', fontSize: 13, outline: 'none', fontFamily: 'DM Sans', width: '100%' }} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px' }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>Low ≤</span>
          <input type="number" min={0} value={threshold} onChange={e => setThreshold(Math.max(0, parseInt(e.target.value) || 0))}
            style={{ width: 44, textAlign: 'center' as const, fontWeight: 600, color: 'var(--text)', background: 'transparent', border: 'none', outline: 'none', fontFamily: 'DM Mono' }} />
        </div>
        {isAdmin && <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px' }} title="A date counts as a real dispatch day only if at least this many orders were dispatched that day (filters out back-dated cleanup days).">
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>Min orders/day</span>
          <input type="number" min={1} value={rrThreshold} onChange={e => setRrThreshold(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ width: 44, textAlign: 'center' as const, fontWeight: 600, color: 'var(--text)', background: 'transparent', border: 'none', outline: 'none', fontFamily: 'DM Mono' }} />
        </div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 7, padding: '5px 12px' }} title="Days of cover the target stock should hold, based on the run rate.">
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text3)', whiteSpace: 'nowrap' as const }}>Target days</span>
          <input type="number" min={1} value={targetDays} onChange={e => setTargetDays(Math.max(1, parseInt(e.target.value) || 1))}
            style={{ width: 44, textAlign: 'center' as const, fontWeight: 600, color: 'var(--text)', background: 'transparent', border: 'none', outline: 'none', fontFamily: 'DM Mono' }} />
        </div>
        <button onClick={() => setLowOnly(v => !v)} style={{ padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: `1px solid ${lowOnly ? '#fecaca' : 'var(--border)'}`, background: lowOnly ? 'var(--critical-bg)' : 'var(--surface)', color: lowOnly ? 'var(--critical)' : 'var(--text3)', display: 'flex', alignItems: 'center', gap: 5 }}>
          <AlertTriangle size={12} /> Low stock{lowCount ? ` (${lowCount})` : ''}
        </button>
      </div>

      {/* Table */}
      {!filtered.length ? (
        <div style={{ ...card, padding: 60, textAlign: 'center' as const, color: 'var(--text2)' }}>
          <Package size={28} style={{ margin: '0 auto 12px', color: 'var(--text3)' }} />
          <p>{lowOnly ? 'No low-stock SKUs' : 'No packed inventory yet'}</p>
        </div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' as const, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 360px)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13, minWidth: 560 }}>
              <thead style={{ position: 'sticky' as const, top: 0, zIndex: 10 }}>
                <tr style={{ background: 'var(--bg2)', borderBottom: '2px solid var(--border2)' }}>
                  {th('SKU / Product', 'descr', 'left')}
                  {th('Stocked', 'stocked')}
                  {isAdmin && <th style={{ background: 'var(--bg2)', padding: '9px 12px', textAlign: 'right' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const }}>Rate/day</th>}
                  <th style={{ background: 'var(--bg2)', padding: '9px 12px', textAlign: 'right' as const, color: 'var(--accent)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const }}>{targetDays}d target</th>
                  {th('Packed', 'packed')}
                  {th('In-Disp', 'in_dispatch')}
                  {th('Disp', 'dispatched')}
                  {th('RTO', 'rto')}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <Fragment key={r.sku}>
                  <tr onClick={() => toggleExpand(r.sku)} style={{ borderBottom: expanded === r.sku ? 'none' : '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)', cursor: 'pointer' }}>
                    <td style={{ padding: '9px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11, color: 'var(--text3)', transform: expanded === r.sku ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
                        {(() => {
                          const img = productImage(r.product || '')
                          return (
                            <span style={{ width: 40, height: 40, flexShrink: 0, borderRadius: 6, overflow: 'hidden', background: 'var(--bg2)', border: '1px solid var(--border)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                              {img
                                ? <img src={img} alt={r.product || r.sku} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
                                : <span style={{ fontSize: 14, color: 'var(--text3)' }}>▧</span>}
                            </span>
                          )
                        })()}
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{r.descr}</span>
                        {r.low && (r.stocked + r.packed) > 0 && <span style={{ fontSize: 9, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '1px 5px', borderRadius: 3 }}>LOW</span>}
                      </div>
                      <div style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)', marginTop: 2, marginLeft: 67 }}>{r.sku}</div>
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: r.stocked > 0 ? 'var(--dispatched)' : 'var(--text3)' }}>{r.stocked}</td>
                    {(() => {
                      const rate = runRate.rateBySku[r.sku] || 0
                      const target = Math.ceil(rate * targetDays)
                      const short = target > r.stocked
                      return (<>
                        {isAdmin && <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: rate > 0 ? 'var(--text2)' : 'var(--text3)' }}>{rate > 0 ? rate.toFixed(1) : '—'}</td>}
                        <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: target === 0 ? 'var(--text3)' : short ? 'var(--critical)' : 'var(--dispatched)' }} title={target > 0 ? `${short ? `short ${target - r.stocked}` : 'covered'} · ${targetDays}-day target ${target}, ${r.stocked} in stock` : undefined}>{target > 0 ? target : '—'}{short && target > 0 && <span style={{ fontSize: 9, marginLeft: 3 }}>▲</span>}</td>
                      </>)
                    })()}
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--accent)' }}>{r.packed}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.in_dispatch}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.dispatched}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.rto}</td>
                  </tr>
                  {expanded === r.sku && (
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                      <td colSpan={isAdmin ? 8 : 7} style={{ padding: '4px 12px 14px 31px' }}>
                        {loadingSku === r.sku ? (
                          <div style={{ fontSize: 12, color: 'var(--text3)', padding: '8px 0' }}>Loading barcodes…</div>
                        ) : (() => {
                          const list = skuBarcodes[r.sku] || []
                          if (!list.length) return <div style={{ fontSize: 12, color: 'var(--text3)', padding: '8px 0' }}>No barcodes.</div>
                          const groups: Record<string, string[]> = {}
                          list.forEach(u => { (groups[u.status] ||= []).push(u.barcode) })
                          const order = ['stocked', 'packed', 'in_dispatch', 'dispatched', 'rto', 'error']
                          const statusColor: Record<string, string> = { stocked: 'var(--dispatched)', packed: 'var(--accent)', in_dispatch: 'var(--text2)', dispatched: 'var(--text2)', rto: 'var(--today)', error: 'var(--critical)' }
                          const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, paddingTop: 6 }}>
                              {keys.map(st => (
                                <div key={st}>
                                  <div style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.05em', color: statusColor[st] || 'var(--text3)', marginBottom: 4 }}>{st.replace('_', '-')} · {groups[st].length}</div>
                                  <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 5 }}>
                                    {groups[st].map(bc => (
                                      <span key={bc} style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 7px' }}>{bc}</span>
                                    ))}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )
                        })()}
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                  <td style={{ padding: '9px 12px', fontWeight: 600, fontSize: 12, color: 'var(--text2)' }}>Total ({filtered.length} SKUs)</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--dispatched)' }}>{filtered.reduce((s, r) => s + r.stocked, 0)}</td>
                  {isAdmin && <td />}<td />
                  <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--accent)' }}>{filtered.reduce((s, r) => s + r.packed, 0)}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text2)' }}>{filtered.reduce((s, r) => s + r.in_dispatch, 0)}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text2)' }}>{filtered.reduce((s, r) => s + r.dispatched, 0)}</td>
                  <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--text2)' }}>{filtered.reduce((s, r) => s + r.rto, 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── Fulfillment waterfall: pending orders vs frame supply ── */}
      <div style={{ marginTop: 12, borderTop: '2px solid var(--border2)', paddingTop: 20 }}>
        <FulfillmentWaterfall />
      </div>
    </div>
  )
}
