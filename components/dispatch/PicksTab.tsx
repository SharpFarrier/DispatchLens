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

export default function PicksTab({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const { getBomForProduct } = useProductStore()
  const [tab, setTab] = useState<'scan' | 'entry' | 'log'>('scan')
  const [pickRefreshKey, setPickRefreshKey] = useState(0)
  const [lineItems, setLineItems] = useState<FrameItem[]>([])
  const [label, setLabel] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [invalidIndices, setInvalidIndices] = useState<number[]>([])
  const [viewMode, setViewMode] = useState<'all' | 'day'>('all')
  const [collapsedDays, setCollapsedDays] = useState<Record<string, boolean>>({})

  const [sessions, setSessions] = useState<Array<{ id: string; label: string | null; created_at: string; pick_items: PickItem[] }>>([])
  const [isFetching, setIsFetching] = useState(false)

  const loadSessions = useCallback(async () => {
    setIsFetching(true)
    const data = await fetchAllRows((from, to) =>
      supabase.from('pick_sessions').select('*, pick_items(*)').neq('status', 'deleted').order('created_at', { ascending: false }).range(from, to))
    setSessions((data as typeof sessions) || [])
    setIsFetching(false)
  }, [supabase])

  useEffect(() => { if (tab === 'log') void loadSessions() }, [tab, loadSessions])

  const flatItems: PickItem[] = useMemo(() => sessions.flatMap(s =>
    (s.pick_items || []).map(i => ({ ...i, session_label: s.label, created_at: s.created_at }))
  ), [sessions])

  const { sorted, sortKey, sortDir, toggleSort } = useSort(flatItems, 'created_at', 'desc')
  const dayGroups = useDayGroups(sorted)

  function toggleDay(dateKey: string) { setCollapsedDays(prev => ({ ...prev, [dateKey]: !prev[dateKey] })) }
  const allCollapsed = () => dayGroups.every(g => collapsedDays[g.dateKey])
  function toggleAllDays() {
    if (allCollapsed()) setCollapsedDays({})
    else { const all: Record<string, boolean> = {}; dayGroups.forEach(g => { all[g.dateKey] = true }); setCollapsedDays(all) }
  }

  function showToast(msg: string, type = 'success') { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  async function handleSubmit() {
    if (!lineItems.length) { showToast('Add at least one frame', 'error'); return }
    const invalid = lineItems.map((item, i) => getItemErrors(item, { requireColour: true }).length > 0 ? i : -1).filter(i => i >= 0)
    if (invalid.length) { setInvalidIndices(invalid); showToast('Some frames are missing required fields', 'error'); return }
    setInvalidIndices([])
    setSubmitting(true)
    try {
      const assemblyItems = lineItems.filter(l => l.is_assembly && l.product_id)
      if (assemblyItems.length) {
        const productIds = [...new Set(assemblyItems.map(l => l.product_id))]
        const [{ data: coatedParts }, { data: priorPicks }] = await Promise.all([
          supabase.from('coating_items')
            .select('product_id, part_id, size, mattress, pieces, coating_trolleys!inner(status)')
            .eq('category', 'parts').in('product_id', productIds)
            .neq('coating_trolleys.status', 'deleted'),
          supabase.from('assembly_picks').select('product_id, size, mattress, quantity').in('product_id', productIds),
        ])
        const warnings: string[] = []
        for (const item of assemblyItems) {
          const bom = getBomForProduct(item.product_id, item.size, item.mattress)
          if (!bom.length) continue
          const matches = (row: { product_id: string; size: string | null; mattress: string | null }) =>
            row.product_id === item.product_id &&
            (row.size || null) === (item.size || null) &&
            ((row.mattress || null) === (item.mattress || null) || row.mattress == null)
          const assembled = (priorPicks || []).filter(matches).reduce((s: number, p: { quantity: number }) => s + p.quantity, 0)
          let completable = Infinity
          for (const b of bom) {
            const coated = (coatedParts || [])
              .filter((c: { part_id: string } & Parameters<typeof matches>[0]) => matches(c) && c.part_id === b.part_id)
              .reduce((s: number, c: { pieces: number }) => s + c.pieces, 0)
            const left = Math.max(0, coated - assembled * b.quantity)
            completable = Math.min(completable, Math.floor(left / b.quantity))
          }
          if (completable !== Infinity && item.pieces > completable) {
            warnings.push(`${item.shape} ${item.size || ''} ${item.mattress || ''}: picking ${item.pieces}, only ${completable} completable from coated parts`)
          }
        }
        if (warnings.length) {
          const ok = window.confirm('⚠ Assembly stock warning:\n\n' + warnings.join('\n') + '\n\nSubmit anyway? (Inventory will show negative parts)')
          if (!ok) { setSubmitting(false); return }
        }
      }

      const { data: session, error } = await supabase.from('pick_sessions')
        .insert({ label: label || null, notes: notes || null, created_by: userId }).select().single()
      if (error) throw error
      const { error: itemsError } = await supabase.from('pick_items').insert(
        lineItems.map(l => ({ session_id: session.id, category: l.category, shape: l.shape, size: l.size || null, mattress: l.mattress || null, colour: l.colour, pieces: l.pieces, product_id: l.product_id || null, part_id: l.part_id || null }))
      )
      if (itemsError) throw itemsError

      if (assemblyItems.length) {
        const { error: apError } = await supabase.from('assembly_picks').insert(
          assemblyItems.map(l => ({
            product_id: l.product_id, size: l.size || null, mattress: l.mattress || null,
            colour: l.colour || null, quantity: l.pieces, pick_session_id: session.id, created_by: userId,
          }))
        )
        if (apError) throw apError
      }
      showToast('Pick saved ✓')
      setLineItems([]); setLabel(''); setNotes('')
      void loadSessions()
    } catch (e) { showToast('Error: ' + (e as Error).message, 'error') }
    setSubmitting(false)
  }

  const tableHead = (
    <thead style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
      <tr>
        <Th label="Date" sortKey="created_at" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Shape" sortKey="shape" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Size" sortKey="size" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Mattress" sortKey="mattress" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Colour" sortKey="colour" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Pcs" sortKey="pieces" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align="right" />
      </tr>
    </thead>
  )

  function renderRow(item: PickItem, i: number) {
    return (
      <tr key={item.id || i} style={{ borderTop: '1px solid var(--border)' }}>
        <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{format(new Date(item.created_at), 'dd MMM yy')}</td>
        <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text)' }}>{item.shape}</td>
        <td style={{ padding: '8px 12px', color: 'var(--text3)' }}>{item.size || '—'}</td>
        <td style={{ padding: '8px 12px', color: 'var(--text3)', fontSize: 12 }}>{item.mattress || '—'}</td>
        <td style={{ padding: '8px 12px', color: 'var(--text2)' }}><ColourDot colour={item.colour} />{item.colour}</td>
        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{item.pieces}</td>
      </tr>
    )
  }

  const totalPcs = sorted.reduce((s, i) => s + (i.pieces || 0), 0)

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 50,
          padding: '12px 20px', borderRadius: 999, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          background: toast.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)',
          color: toast.type === 'error' ? 'var(--critical)' : 'var(--dispatched)', border: '1px solid var(--border)',
        }}>{toast.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '8px 16px', borderRadius: 10, fontSize: 13, fontWeight: 700, textTransform: 'capitalize', cursor: 'pointer',
              border: tab === t ? 'none' : '1px solid var(--border)',
              background: tab === t ? 'var(--accent)' : 'var(--surface)', color: tab === t ? '#fff' : 'var(--text3)',
            }}>{t}</button>
        ))}
      </div>

      {tab === 'scan' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <PackSchedulePanel />
          <PickDayStats userId={userId} refreshKey={pickRefreshKey} />
          <PickScanTerminal userId={userId} onToast={showToast}
            onPicked={() => setPickRefreshKey(k => k + 1)}
            onSessionClosed={() => setPickRefreshKey(k => k + 1)} />
        </div>
      )}

      {tab === 'entry' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 10, padding: '12px 16px', fontSize: 13, fontWeight: 700 }}>
            {format(new Date(), 'EEE, dd MMM yyyy • hh:mm:ss aa')}
          </div>
          <div>
            <div style={sectionTitle}>Frames in this Pick</div>
            <LineItemList items={lineItems} onRemove={i => { setLineItems(p => p.filter((_, idx) => idx !== i)); setInvalidIndices([]) }} invalidIndices={invalidIndices} />
          </div>
          <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: 16 }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>+ Add Frame</div>
            <FramePicker mode="picks" showColour onAdd={item => setLineItems(p => [...p, item])} />
          </div>
          <div>
            <div style={sectionTitle}>Pick Details</div>
            <input style={inputField} placeholder="Pick ID / Label" value={label} onChange={e => setLabel(e.target.value)} />
          </div>
          <div>
            <div style={sectionTitle}>Notes <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
            <textarea style={{ ...inputField, resize: 'none' }} rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          <button onClick={handleSubmit} disabled={submitting || !lineItems.length}
            style={{ width: '100%', padding: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (submitting || !lineItems.length) ? 0.4 : 1 }}>
            {submitting ? 'Saving...' : 'Submit Pick'}
          </button>
        </div>
      )}

      {tab === 'log' && (
        <LogTable isFetching={isFetching} hasData={!!sorted.length} viewMode={viewMode} setViewMode={setViewMode}
          allCollapsed={allCollapsed()} toggleAllDays={toggleAllDays} tableHead={tableHead}
          sorted={sorted} dayGroups={dayGroups} collapsedDays={collapsedDays} toggleDay={toggleDay}
          renderRow={renderRow} totalPcs={totalPcs} colCount={COL_COUNT} emptyIcon="🤚" emptyMsg="No pick sessions yet" />
      )}
    </div>
  )
}
