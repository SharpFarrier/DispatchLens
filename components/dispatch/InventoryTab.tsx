'use client'
import { useState, useEffect, useMemo, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Package, Search, AlertTriangle } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

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
        supabase.from('packed_units').select('barcode, status').eq('sku', sku).order('seq').range(from, to))
      setSkuBarcodes(prev => ({ ...prev, [sku]: rows }))
      setLoadingSku(null)
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true)
      // packed_units can exceed Supabase's 1000-row cap — page through all rows.
      const allUnits = await fetchAllRows<PackedUnitRow>((from, to) =>
        supabase.from('packed_units').select('sku, status').range(from, to))
      const s = await supabase.from('packed_skus').select('sku, descr, product')
      setUnits(allUnits)
      setSkus((s.data as PackedSkuRow[]) || [])
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
    <th onClick={() => toggleSort(k)} style={{ padding: '9px 12px', textAlign: align, color: sortKey === k ? 'var(--accent)' : 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const, cursor: 'pointer', userSelect: 'none' as const }}>
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
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13, minWidth: 560 }}>
              <thead>
                <tr style={{ background: 'var(--bg2)', borderBottom: '2px solid var(--border2)' }}>
                  {th('SKU / Product', 'descr', 'left')}
                  {th('Stocked', 'stocked')}
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
                        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{r.descr}</span>
                        {r.low && (r.stocked + r.packed) > 0 && <span style={{ fontSize: 9, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '1px 5px', borderRadius: 3 }}>LOW</span>}
                      </div>
                      <div style={{ fontSize: 11, fontFamily: 'DM Mono', color: 'var(--text3)', marginTop: 2, marginLeft: 19 }}>{r.sku}</div>
                    </td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: r.stocked > 0 ? 'var(--dispatched)' : 'var(--text3)' }}>{r.stocked}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--accent)' }}>{r.packed}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.in_dispatch}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.dispatched}</td>
                    <td style={{ padding: '9px 12px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.rto}</td>
                  </tr>
                  {expanded === r.sku && (
                    <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                      <td colSpan={6} style={{ padding: '4px 12px 14px 31px' }}>
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
    </div>
  )
}
