'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { format } from 'date-fns'
import { ColourDot, Th } from './warehouse-ui'
import { useSort, useDayGroups } from './warehouse-hooks'
import { useProductStore } from './useProductStore'
import FramePicker, { type FrameItem } from './FramePicker'
import LineItemList, { getItemErrors } from './LineItemList'
import PickScanTerminal from './PickScanTerminal'
import PickDayStats from './PickDayStats'
import { LogTable } from './CoatingTab'

const TABS = ['scan', 'log'] as const
const COL_COUNT = 6

interface PickItem {
  id?: string; shape: string; size: string | null; mattress: string | null
  colour: string; pieces: number; session_label: string | null; created_at: string; [k: string]: unknown
}

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const inputField = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' as const }

// Live pack schedule: SKUs in today's picklist whose demand exceeds available stock.
// shortfall = (Delhivery + Bluedart demand for today) - stocked pieces available. Read-only;
// a SKU drops off as soon as its barcode is generated (piece becomes 'stocked' -> stock rises).
function PackSchedulePanel() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<{ sku: string; name: string | null; needed: number; stock: number; toPack: number }[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const today = new Date().toISOString().slice(0, 10)
    // Demand for today's picklist (same basis as the Pick tab): scheduled today, not cancelled/dispatched.
    const orders = await fetchAllRows<{ sku: string | null; barcode_sku: string | null; is_cancelled: boolean | null; is_dispatched: boolean | null }>((from, to) =>
      supabase.from('dispatch_orders').select('sku, barcode_sku, is_cancelled, is_dispatched')
        .eq('plan_decision', 'scheduled').eq('scheduled_date', today).range(from, to))
    const demand: Record<string, number> = {}
    for (const o of orders) {
      if (o.is_cancelled || o.is_dispatched) continue
      const k = (o.barcode_sku || o.sku || '').trim(); if (!k) continue
      demand[k] = (demand[k] || 0) + 1
    }
    // Available stock per SKU (stocked pieces).
    // Available = pieces already MADE and not yet shipped ('stocked' OR 'picked'). A picked piece
    // is staged for dispatch (not dispatched) — it exists, so it must NOT be re-made.
    // Counted on the DATABASE via an aggregate RPC: packed_units is huge, and fetching every row
    // to count client-side under-counted at scale (stock read as 0). One grouped query instead.
    const { data: availData } = await supabase.rpc('pack_available_counts')
    const stock: Record<string, number> = {}
    for (const r of (availData || []) as { sku: string; available: number }[]) {
      const k = (r.sku || '').trim(); if (k) stock[k] = Number(r.available) || 0
    }
    // Product names.
    const maps = await fetchAllRows<{ master_sku: string; product_name: string | null }>((from, to) =>
      supabase.from('dispatch_sku_map').select('master_sku, product_name').range(from, to))
    const nm: Record<string, string> = {}
    for (const m of maps) if (m.product_name) nm[m.master_sku] = m.product_name
    // Shortfall rows (positive only), largest first.
    const out = Object.keys(demand).map(k => ({ sku: k, name: nm[k] || null, needed: demand[k], stock: stock[k] || 0, toPack: demand[k] - (stock[k] || 0) }))
      .filter(r => r.toPack > 0).sort((a, b) => b.toPack - a.toPack)
    setRows(out); setLoading(false)
  }, [supabase])

  useEffect(() => { void load(); const iv = setInterval(() => void load(), 30000); return () => clearInterval(iv) }, [load])

  const totalPieces = rows.reduce((s, r) => s + r.toPack, 0)

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' as const, background: 'var(--surface)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const, padding: '12px 16px', borderBottom: rows.length ? '1px solid var(--border)' : 'none' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>To Pack — today&apos;s shortfall</h3>
        {rows.length > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--critical)', background: 'var(--critical-bg)', padding: '2px 9px', borderRadius: 20 }}>{totalPieces} piece{totalPieces === 1 ? '' : 's'} · {rows.length} SKU{rows.length === 1 ? '' : 's'}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 5 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--dispatched)', display: 'inline-block' }} />Live</span>
      </div>
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center' as const, color: 'var(--dispatched)', fontSize: 13, fontWeight: 600 }}>Nothing to pack — stock covers today&apos;s picklist ✓</div>
      ) : (
        <div style={{ overflowX: 'auto' as const }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
            <thead><tr>
              {['SKU', 'Needed', 'Available', 'To pack'].map((h, i) => (
                <th key={h} style={{ padding: '8px 14px', textAlign: i === 0 ? 'left' as const : 'center' as const, background: 'var(--bg2)', color: 'var(--text3)', fontSize: 11, textTransform: 'uppercase' as const, letterSpacing: '0.06em', fontWeight: 600 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.sku} style={{ borderTop: '1px solid var(--border)', background: i % 2 ? 'var(--bg2)' : 'transparent' }}>
                  <td style={{ padding: '11px 14px' }}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 600 }}>{r.sku}</div>
                    {r.name && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.name}</div>}
                  </td>
                  <td style={{ padding: '11px 14px', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 13 }}>{r.needed}</td>
                  <td style={{ padding: '11px 14px', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--text3)' }}>{r.stock}</td>
                  <td style={{ padding: '11px 14px', textAlign: 'center' as const, fontFamily: 'var(--font-mono)', fontSize: 16, fontWeight: 700, color: 'var(--critical)' }}>{r.toPack}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Frame pick step retired (Phase 3: the pack scan links box -> frame via piece_id,
// so coated frames are consumed directly at Pack & Map). This tab now shows only the
// live pack schedule — scanning, manual pick entry and the pick log were removed.
export default function PicksTab(_props: { userId: string }) {
  return (
    <div>
      <h2 style={{ fontSize: 18, fontWeight: 800, color: 'var(--text)', margin: '0 0 16px' }}>Pack Schedule</h2>
      <PackSchedulePanel />
    </div>
  )
}
