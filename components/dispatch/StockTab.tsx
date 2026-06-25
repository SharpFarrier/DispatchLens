'use client'
import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { format } from 'date-fns'
import { Spinner, EmptyState, Th } from './warehouse-ui'
import { useSort, useDayGroups } from './warehouse-hooks'
import FramePicker, { type FrameItem } from './FramePicker'
import LineItemList from './LineItemList'

const SUPPLIERS = ['Bunty', 'Mahinder', 'Other']
const TABS = ['entry', 'log'] as const
const COL_COUNT = 6

interface FlatItem {
  id?: string
  shape: string
  size: string | null
  mattress: string | null
  pieces: number
  supplier: string
  vehicle_no: string | null
  created_at: string
  shipment_id: string
  [k: string]: unknown
}

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const inputField = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' as const }

export default function StockTab({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [tab, setTab] = useState<'entry' | 'log'>('entry')
  const [lineItems, setLineItems] = useState<FrameItem[]>([])
  const [supplier, setSupplier] = useState('')
  const [supplierOther, setSupplierOther] = useState('')
  const [vehicleNo, setVehicleNo] = useState('')
  const [weight, setWeight] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [viewMode, setViewMode] = useState<'all' | 'day'>('all')
  const [collapsedDays, setCollapsedDays] = useState<Record<string, boolean>>({})

  const [shipments, setShipments] = useState<Array<{ id: string; supplier: string; vehicle_no: string | null; created_at: string; shipment_items: FlatItem[] }>>([])
  const [isLoading, setIsLoading] = useState(false)

  const loadShipments = useCallback(async () => {
    setIsLoading(true)
    const { data } = await supabase
      .from('shipments')
      .select('*, shipment_items(*)')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(200)
    setShipments(data || [])
    setIsLoading(false)
  }, [supabase])

  useEffect(() => {
    if (tab === 'log') void loadShipments()
  }, [tab, loadShipments])

  const flatItems: FlatItem[] = useMemo(() => {
    return shipments.flatMap(s =>
      (s.shipment_items || []).map(i => ({
        ...i,
        supplier: s.supplier,
        vehicle_no: s.vehicle_no,
        created_at: s.created_at,
        shipment_id: s.id,
      }))
    )
  }, [shipments])

  const { sorted: sortedItems, sortKey, sortDir, toggleSort } = useSort(flatItems, 'created_at', 'desc')
  const dayGroups = useDayGroups(sortedItems)

  function toggleDay(dateKey: string) {
    setCollapsedDays(prev => ({ ...prev, [dateKey]: !prev[dateKey] }))
  }
  const allCollapsed = () => dayGroups.every(g => collapsedDays[g.dateKey])
  function toggleAllDays() {
    if (allCollapsed()) { setCollapsedDays({}) }
    else {
      const all: Record<string, boolean> = {}
      dayGroups.forEach(g => { all[g.dateKey] = true })
      setCollapsedDays(all)
    }
  }

  function showToast(msg: string, type = 'success') { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  async function handleSubmit() {
    if (!lineItems.length) { showToast('Add at least one frame', 'error'); return }
    if (!supplier) { showToast('Select a supplier', 'error'); return }
    const supplierName = supplier === 'Other' ? supplierOther.trim() : supplier
    if (!supplierName) { showToast('Enter supplier name', 'error'); return }
    setSubmitting(true)
    try {
      const { data: shipment, error } = await supabase
        .from('shipments')
        .insert({ supplier: supplierName, vehicle_no: vehicleNo || null, weight_kg: weight || null, notes: notes || null, created_by: userId })
        .select().single()
      if (error) throw error
      const { error: itemsErr } = await supabase.from('shipment_items').insert(
        lineItems.map(l => ({ shipment_id: shipment.id, category: l.category, shape: l.shape, size: l.size || null, mattress: l.mattress || null, pieces: l.pieces }))
      )
      if (itemsErr) throw itemsErr
      showToast('Shipment saved ✓')
      setLineItems([]); setSupplier(''); setSupplierOther(''); setVehicleNo(''); setWeight(''); setNotes('')
      void loadShipments()
    } catch (e) { showToast('Error: ' + (e as Error).message, 'error') }
    setSubmitting(false)
  }

  const tableHead = (
    <thead style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
      <tr>
        <Th label="Date" sortKey="created_at" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Supplier" sortKey="supplier" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Shape" sortKey="shape" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Size" sortKey="size" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Mattress" sortKey="mattress" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} />
        <Th label="Pcs" sortKey="pieces" currentKey={sortKey} currentDir={sortDir} onSort={toggleSort} align="right" />
      </tr>
    </thead>
  )

  function renderRow(item: FlatItem, i: number) {
    return (
      <tr key={item.id || i} style={{ borderTop: '1px solid var(--border)' }}>
        <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{format(new Date(item.created_at), 'dd MMM yy')}</td>
        <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text2)' }}>{item.supplier}</td>
        <td style={{ padding: '8px 12px', fontWeight: 600, color: 'var(--text)' }}>{item.shape}</td>
        <td style={{ padding: '8px 12px', color: 'var(--text3)' }}>{item.size || '—'}</td>
        <td style={{ padding: '8px 12px', color: 'var(--text3)', fontSize: 12 }}>{item.mattress || '—'}</td>
        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{item.pieces}</td>
      </tr>
    )
  }

  const totalPcs = sortedItems.reduce((s, i) => s + (i.pieces || 0), 0)

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 50,
          padding: '12px 20px', borderRadius: 999, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          background: toast.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)',
          color: toast.type === 'error' ? 'var(--critical)' : 'var(--dispatched)',
          border: '1px solid var(--border)',
        }}>{toast.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{
              padding: '8px 16px', borderRadius: 10, fontSize: 13, fontWeight: 700, textTransform: 'capitalize', cursor: 'pointer',
              border: tab === t ? 'none' : '1px solid var(--border)',
              background: tab === t ? 'var(--accent)' : 'var(--surface)',
              color: tab === t ? '#fff' : 'var(--text3)',
            }}>{t}</button>
        ))}
      </div>

      {tab === 'entry' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 10, padding: '12px 16px', fontSize: 13, fontWeight: 700 }}>
            {format(new Date(), 'EEE, dd MMM yyyy • hh:mm:ss aa')}
          </div>

          <div>
            <div style={sectionTitle}>Frames in this Shipment</div>
            <LineItemList items={lineItems} onRemove={i => setLineItems(p => p.filter((_, idx) => idx !== i))} />
          </div>

          <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: 16 }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>+ Add Frame</div>
            <FramePicker mode="inward" onAdd={item => setLineItems(p => [...p, item])} showColour={false} />
          </div>

          <div>
            <div style={sectionTitle}>Vehicle Details</div>
            <input style={inputField} placeholder="Vehicle number (e.g. MH 04 AB 1234)" value={vehicleNo} onChange={e => setVehicleNo(e.target.value)} />
          </div>

          <div>
            <div style={sectionTitle}>Supplier *</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 8 }}>
              {SUPPLIERS.map(s => (
                <button key={s} onClick={() => setSupplier(s)}
                  style={{
                    padding: 12, borderRadius: 10, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                    border: supplier === s ? '2px solid var(--accent)' : '2px solid var(--border)',
                    background: supplier === s ? 'var(--accent-bg)' : 'var(--surface)',
                    color: supplier === s ? 'var(--accent)' : 'var(--text3)',
                  }}>{s}</button>
              ))}
            </div>
            {supplier === 'Other' && (
              <input style={inputField} placeholder="Supplier name" value={supplierOther} onChange={e => setSupplierOther(e.target.value)} />
            )}
          </div>

          <div>
            <div style={sectionTitle}>Shipment Weight <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
            <div style={{ display: 'flex' }}>
              <input type="number" inputMode="decimal" style={{ ...inputField, borderTopRightRadius: 0, borderBottomRightRadius: 0 }} placeholder="e.g. 1320" value={weight} onChange={e => setWeight(e.target.value)} />
              <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: 'none', borderTopRightRadius: 10, borderBottomRightRadius: 10, padding: '0 16px', display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text3)' }}>kg</div>
            </div>
          </div>

          <div>
            <div style={sectionTitle}>Notes <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
            <textarea style={{ ...inputField, resize: 'none' }} rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>

          <button onClick={handleSubmit} disabled={submitting || !lineItems.length}
            style={{
              width: '100%', padding: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15,
              borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (submitting || !lineItems.length) ? 0.4 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
            {submitting ? 'Saving...' : 'Submit Shipment'}
          </button>
        </div>
      )}

      {tab === 'log' && (
        <div>
          {isLoading ? <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Spinner size="lg" /></div>
            : !sortedItems.length ? <EmptyState icon="📦" message="No shipments yet" />
              : (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {(['all', 'day'] as const).map(vm => (
                        <button key={vm} onClick={() => setViewMode(vm)}
                          style={{
                            padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                            border: viewMode === vm ? 'none' : '1px solid var(--border)',
                            background: viewMode === vm ? 'var(--accent)' : 'var(--surface)',
                            color: viewMode === vm ? '#fff' : 'var(--text3)',
                          }}>{vm === 'all' ? 'All Rows' : 'Day View'}</button>
                      ))}
                    </div>
                    {viewMode === 'day' && (
                      <button onClick={toggleAllDays}
                        style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: 'var(--surface)', color: 'var(--text3)', border: '1px solid var(--border)', cursor: 'pointer' }}>
                        {allCollapsed() ? 'Expand All' : 'Collapse All'}
                      </button>
                    )}
                  </div>

                  <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'auto' }}>
                    <table style={{ width: '100%', fontSize: 14, minWidth: 520, borderCollapse: 'collapse' }}>
                      {tableHead}
                      {viewMode === 'all' ? (
                        <>
                          <tbody>
                            {sortedItems.map((item, i) => renderRow(item, i))}
                          </tbody>
                          <tfoot style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)' }}>
                            <tr>
                              <td colSpan={COL_COUNT - 1} style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>Total ({sortedItems.length} rows)</td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{totalPcs}</td>
                            </tr>
                          </tfoot>
                        </>
                      ) : (
                        <>
                          <tbody>
                            {dayGroups.map(group => (
                              <DayGroupRows key={group.dateKey} group={group} collapsed={!!collapsedDays[group.dateKey]} onToggle={() => toggleDay(group.dateKey)} renderRow={renderRow} colCount={COL_COUNT} />
                            ))}
                          </tbody>
                          <tfoot style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)' }}>
                            <tr>
                              <td colSpan={COL_COUNT - 1} style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>Total ({sortedItems.length} rows, {dayGroups.length} days)</td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{totalPcs}</td>
                            </tr>
                          </tfoot>
                        </>
                      )}
                    </table>
                  </div>
                </div>
              )}
        </div>
      )}
    </div>
  )
}

// Day group as a fragment of <tr>s (header + rows)
function DayGroupRows({ group, collapsed, onToggle, renderRow, colCount }: {
  group: { dateKey: string; items: FlatItem[]; total: number }
  collapsed: boolean; onToggle: () => void
  renderRow: (item: FlatItem, i: number) => ReactNode; colCount: number
}) {
  return (
    <>
      <tr onClick={onToggle} style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)', cursor: 'pointer', userSelect: 'none' }}>
        <td colSpan={colCount} style={{ padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', width: 12 }}>{collapsed ? '▶' : '▼'}</span>
              <span style={{ fontWeight: 700, color: 'var(--text2)', fontSize: 12 }}>{group.dateKey}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{group.items.length} rows</span>
            </div>
            <span style={{ fontWeight: 800, color: 'var(--accent)', fontSize: 14 }}>{group.total} pcs</span>
          </div>
        </td>
      </tr>
      {!collapsed && group.items.map((item, i) => renderRow(item, i))}
    </>
  )
}
