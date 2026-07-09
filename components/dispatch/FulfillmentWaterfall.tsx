'use client'
import { useState, useEffect, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { AlertTriangle, CheckCircle } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

// Bed size vocabulary bridge: packed_skus.size → opening_stock/pieces size.
// Tables (4ft) and chairs (null) are intentionally excluded — beds only.
const SIZE_MAP: Record<string, string> = {
  '2.5x6': 'Single 2.5ft',
  '3x6': 'Single 3ft',
  '4x6.25': 'Double 4ft',
  '5x6.25': 'Queen 5ft',
  '5x6.5': 'Queen 5ft',   // Luvo/Elvo share the Queen pool
  '6x6.25': 'King 6ft',
}

// Product family (packed_skus.product, a marketing name) → frame shape.
// products.name is shape-named ("Element Bed"), so it can't be joined to the
// marketing product name directly — this is the authoritative bridge.
const PRODUCT_SHAPE: Record<string, string> = {
  'Nova': 'Element',
  'Jasper': 'Headboard',
  'Atlas': 'Round',
  'Aura': 'Round',
  'Nexon': 'Square',
  'Avon': 'Metal',
  'Oslo': 'Oslo',
  'Boston': 'Golden',
  'Base': 'Base',
  'Luvo': 'Wooden',
  'Elvo': 'Wooden',
}

interface OrderRow { barcode_sku: string | null; plan_decision: string; is_dispatched: boolean; is_cancelled: boolean; qty: number | null }
interface SkuMeta { sku: string; product: string; size: string | null; mattress: string | null }
interface ProductShape { product_id: string; name: string; shape: string }

interface WaterfallRow {
  key: string; shape: string; size: string
  orders: number
  finished: number; coated: number; raw: number
  fromFinished: number; fromCoated: number; fromRaw: number
  procure: number
}

export default function FulfillmentWaterfall() {
  const supabase = createClient()
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState<WaterfallRow[]>([])
  const [shortOnly, setShortOnly] = useState(false)

  useEffect(() => {
    (async () => {
      setLoading(true)

      // 1. Pending demand — undecided + scheduled, not dispatched/cancelled.
      const orders = await fetchAllRows<OrderRow>((from, to) =>
        supabase.from('dispatch_orders')
          .select('barcode_sku, plan_decision, is_dispatched, is_cancelled, qty')
          .order('id', { ascending: false }).range(from, to))

      // 2. SKU → attributes (product, size, mattress).
      const skuRes = await supabase.from('packed_skus').select('sku, product, size, mattress')
      const skuMeta: Record<string, SkuMeta> = {}
      for (const s of (skuRes.data as SkuMeta[]) || []) skuMeta[s.sku] = s

      // 3. Finished stock — stocked packed_units, per SKU → resolve to shape+size.
      const units = await fetchAllRows<{ sku: string; status: string }>((from, to) =>
        supabase.from('packed_units').select('sku, status').order('id', { ascending: false }).range(from, to))

      // 4. Coated pool — pieces status=coated, per shape+size (already supply-vocab size).
      const coated = await fetchAllRows<{ shape: string; size: string | null }>((from, to) =>
        supabase.from('pieces').select('shape, size').eq('status', 'coated').order('id', { ascending: false }).range(from, to))

      // 5. Raw pool — opening_stock raw entries, per shape+size (net of coated already).
      const rawRes = await supabase.from('opening_stock').select('entry_type, shape, size, pieces')
      const rawList = ((rawRes.data as { entry_type: string; shape: string; size: string | null; pieces: number }[]) || [])
        .filter(r => r.entry_type === 'raw')

      // ── Aggregate everything to a shape+size key ──
      const keyOf = (shape: string, size: string) => `${shape}__${size}`

      // Demand: order → barcode_sku → meta → shape (via product) + mapped size.
      const demand: Record<string, number> = {}
      const finished: Record<string, number> = {}
      for (const o of orders) {
        if (o.is_dispatched || o.is_cancelled) continue
        if (o.plan_decision !== 'undecided' && o.plan_decision !== 'scheduled') continue
        const meta = skuMeta[(o.barcode_sku || '').trim()]
        if (!meta || !meta.size) continue
        const shape = PRODUCT_SHAPE[meta.product]
        const size = SIZE_MAP[meta.size]
        if (!shape || !size) continue   // non-bed or unmapped → excluded
        demand[keyOf(shape, size)] = (demand[keyOf(shape, size)] || 0) + (o.qty || 1)
      }

      // Finished: stocked unit → sku meta → shape+size.
      for (const u of units) {
        if (u.status !== 'stocked') continue
        const meta = skuMeta[(u.sku || '').trim()]
        if (!meta || !meta.size) continue
        const shape = PRODUCT_SHAPE[meta.product]
        const size = SIZE_MAP[meta.size]
        if (!shape || !size) continue
        finished[keyOf(shape, size)] = (finished[keyOf(shape, size)] || 0) + 1
      }

      // Coated: already shape+size in supply vocab.
      const coatedAgg: Record<string, number> = {}
      for (const c of coated) {
        if (!c.shape || !c.size) continue
        coatedAgg[keyOf(c.shape, c.size)] = (coatedAgg[keyOf(c.shape, c.size)] || 0) + 1
      }

      // Raw: sum pieces per shape+size (collapse the With/Without-mattress split).
      const rawAgg: Record<string, number> = {}
      for (const r of rawList) {
        if (!r.shape || !r.size) continue
        rawAgg[keyOf(r.shape, r.size)] = (rawAgg[keyOf(r.shape, r.size)] || 0) + (r.pieces || 0)
      }

      // ── Waterfall allocation per shape+size ──
      const allKeys = new Set<string>([...Object.keys(demand), ...Object.keys(finished)])
      const out: WaterfallRow[] = []
      for (const k of allKeys) {
        const [shape, size] = k.split('__')
        const orders_ = demand[k] || 0
        if (orders_ === 0) continue   // only show shapes with pending demand
        const fin = finished[k] || 0
        const coa = coatedAgg[k] || 0
        const raw = rawAgg[k] || 0

        let remaining = orders_
        const fromFinished = Math.min(remaining, fin); remaining -= fromFinished
        const fromCoated = Math.min(remaining, coa); remaining -= fromCoated
        const fromRaw = Math.min(remaining, raw); remaining -= fromRaw
        const procure = remaining

        out.push({ key: k, shape, size, orders: orders_, finished: fin, coated: coa, raw, fromFinished, fromCoated, fromRaw, procure })
      }

      // Sort: shortfalls first (biggest procure), then by orders.
      out.sort((a, b) => b.procure - a.procure || b.orders - a.orders)
      setRows(out)
      setLoading(false)
    })()
  }, [supabase])

  const shown = useMemo(() => shortOnly ? rows.filter(r => r.procure > 0) : rows, [rows, shortOnly])
  const totalProcure = useMemo(() => rows.reduce((s, r) => s + r.procure, 0), [rows])
  const shortCount = useMemo(() => rows.filter(r => r.procure > 0).length, [rows])

  if (loading) return <div style={{ ...card, padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>Computing fulfillment…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Fulfillment — pending orders vs frame supply</h2>
        <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'DM Mono' }}>beds only · by shape + size</span>
        {shortCount > 0
          ? <span style={{ fontSize: 12, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--critical)', background: 'var(--critical-bg)', border: '1px solid #fecaca', padding: '3px 10px', borderRadius: 20, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <AlertTriangle size={12} /> procure {totalProcure} across {shortCount}
            </span>
          : <span style={{ fontSize: 12, fontFamily: 'DM Mono', fontWeight: 600, color: 'var(--dispatched)', background: 'var(--dispatched-bg)', border: '1px solid #bbf7d0', padding: '3px 10px', borderRadius: 20, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <CheckCircle size={12} /> all fulfillable
            </span>}
        <button onClick={() => setShortOnly(v => !v)}
          style={{ marginLeft: 'auto', padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: shortOnly ? 'var(--critical-bg)' : 'var(--surface)', color: shortOnly ? 'var(--critical)' : 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          {shortOnly ? 'Showing shortfalls' : 'Show shortfalls only'}
        </button>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' as const }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13, minWidth: 720 }}>
            <thead>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                {['Frame · size', 'Orders', 'Finished', 'Coated', 'Raw', 'Procure'].map((h, i) => (
                  <th key={i} style={{ padding: '9px 14px', textAlign: i === 0 ? 'left' as const : 'right' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: 'center' as const, color: 'var(--text3)' }}>{shortOnly ? 'No shortfalls — everything is fulfillable.' : 'No pending bed orders.'}</td></tr>
              ) : shown.map((r, i) => {
                const short = r.procure > 0
                return (
                  <tr key={r.key} style={{ borderBottom: '1px solid var(--border)', background: short ? 'var(--critical-bg)' : (i % 2 === 0 ? 'transparent' : 'var(--bg2)') }}>
                    <td style={{ padding: '9px 14px', whiteSpace: 'nowrap' as const }}>
                      <span style={{ fontWeight: 600, color: short ? 'var(--critical)' : 'var(--text)' }}>{r.shape}</span>
                      <span style={{ color: 'var(--text3)', fontSize: 12, marginLeft: 6 }}>{r.size}</span>
                    </td>
                    <td style={{ padding: '9px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, fontSize: 14 }}>{r.orders}</td>
                    <td style={{ padding: '9px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--dispatched)' }}>{r.finished}<span style={{ color: 'var(--text3)', fontSize: 10 }}> ·{r.fromFinished}</span></td>
                    <td style={{ padding: '9px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--accent)' }}>{r.coated}<span style={{ color: 'var(--text3)', fontSize: 10 }}> ·{r.fromCoated}</span></td>
                    <td style={{ padding: '9px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', color: 'var(--text2)' }}>{r.raw}<span style={{ color: 'var(--text3)', fontSize: 10 }}> ·{r.fromRaw}</span></td>
                    <td style={{ padding: '9px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, fontSize: 14, color: short ? 'var(--critical)' : 'var(--dispatched)' }}>{short ? r.procure : '✓'}</td>
                  </tr>
                )
              })}
            </tbody>
            {shown.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border2)', background: 'var(--bg2)' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 700, fontSize: 13 }}>Total · {shown.length} frames</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700 }}>{shown.reduce((s, r) => s + r.orders, 0)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--dispatched)' }}>{shown.reduce((s, r) => s + r.finished, 0)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--accent)' }}>{shown.reduce((s, r) => s + r.coated, 0)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--text2)' }}>{shown.reduce((s, r) => s + r.raw, 0)}</td>
                  <td style={{ padding: '10px 14px', textAlign: 'right' as const, fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--critical)' }}>{shown.reduce((s, r) => s + r.procure, 0)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        Each row: pending orders drawn down finished → coated → raw. The small <span style={{ fontFamily: 'DM Mono' }}>·n</span> after each stock number is how much of it this demand consumes. <b>Procure</b> = orders still unmet after all three stages (raw frames to make/buy). Finished is SKU-exact; coated and raw are shared shape+size frame pools.
      </div>
    </div>
  )
}
