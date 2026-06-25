'use client'
import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react'
import { createClient } from '@/lib/supabase/client'
import { format } from 'date-fns'
import { Spinner, EmptyState, ColourDot, Th } from './warehouse-ui'
import { useSort, useDayGroups } from './warehouse-hooks'
import FramePicker, { type FrameItem } from './FramePicker'
import LineItemList, { getItemErrors } from './LineItemList'
import { shareLabelsPDF, type LabelPiece } from './labelGenerator'

const TABS = ['entry', 'log'] as const
const COL_COUNT = 6

interface CoatingItem {
  id?: string; shape: string; size: string | null; mattress: string | null
  colour: string; pieces: number; trolley_id: string; trolley_label: string | null
  created_at: string; [k: string]: unknown
}

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const inputField = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' as const }

export default function CoatingTab({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [tab, setTab] = useState<'entry' | 'log'>('entry')
  const [lineItems, setLineItems] = useState<FrameItem[]>([])
  const [label, setLabel] = useState('')
  const [temp, setTemp] = useState('')
  const [duration, setDuration] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [invalidIndices, setInvalidIndices] = useState<number[]>([])
  const [viewMode, setViewMode] = useState<'all' | 'day'>('all')
  const [collapsedDays, setCollapsedDays] = useState<Record<string, boolean>>({})
  const [lastLabels, setLastLabels] = useState<LabelPiece[] | null>(null)
  const [reprintingId, setReprintingId] = useState<string | null>(null)

  const [trolleys, setTrolleys] = useState<Array<{ id: string; label: string | null; created_at: string; coating_items: CoatingItem[] }>>([])
  const [isFetching, setIsFetching] = useState(false)

  const loadTrolleys = useCallback(async () => {
    setIsFetching(true)
    const { data } = await supabase
      .from('coating_trolleys')
      .select('*, coating_items(*), profiles(full_name)')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(200)
    setTrolleys(data || [])
    setIsFetching(false)
  }, [supabase])

  useEffect(() => { if (tab === 'log') void loadTrolleys() }, [tab, loadTrolleys])

  const flatItems: CoatingItem[] = useMemo(() => trolleys.flatMap(t =>
    (t.coating_items || []).map(i => ({ ...i, trolley_label: t.label, created_at: t.created_at }))
  ), [trolleys])

  const { sorted, sortKey, sortDir, toggleSort } = useSort(flatItems, 'created_at', 'desc')
  const dayGroups = useDayGroups(sorted)

  function toggleDay(dateKey: string) { setCollapsedDays(prev => ({ ...prev, [dateKey]: !prev[dateKey] })) }
  const allCollapsed = () => dayGroups.every(g => collapsedDays[g.dateKey])
  function toggleAllDays() {
    if (allCollapsed()) setCollapsedDays({})
    else { const all: Record<string, boolean> = {}; dayGroups.forEach(g => { all[g.dateKey] = true }); setCollapsedDays(all) }
  }

  function showToast(msg: string, type = 'success') { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  async function handleShareLabels() {
    if (!lastLabels || !lastLabels.length) return
    try {
      const result = await shareLabelsPDF(lastLabels, `coating-labels-${format(new Date(), 'ddMMM-HHmm')}.pdf`)
      if (result === 'downloaded') showToast('Labels PDF downloaded')
      else if (result === 'shared') showToast('Labels shared ✓')
    } catch (e) { showToast('Label error: ' + (e as Error).message, 'error') }
  }

  async function handleReprint(trolleyId: string) {
    setReprintingId(trolleyId)
    try {
      const { data: pieces, error } = await supabase
        .from('pieces').select('barcode, shape, size, colour, mattress')
        .eq('coating_trolley_id', trolleyId).order('barcode')
      if (error) throw error
      if (!pieces || !pieces.length) { showToast('No barcoded pieces for this trolley', 'error'); return }
      const result = await shareLabelsPDF(pieces as LabelPiece[], 'coating-labels-reprint.pdf')
      if (result === 'downloaded') showToast(`${pieces.length} label(s) downloaded`)
      else if (result === 'shared') showToast(`${pieces.length} label(s) shared ✓`)
    } catch (e) { showToast('Reprint error: ' + (e as Error).message, 'error') }
    setReprintingId(null)
  }

  async function handleSubmit() {
    if (!lineItems.length) { showToast('Add at least one frame', 'error'); return }
    const invalid = lineItems.map((item, i) => getItemErrors(item, { requireColour: true }).length > 0 ? i : -1).filter(i => i >= 0)
    if (invalid.length) { setInvalidIndices(invalid); showToast('Some frames are missing required fields', 'error'); return }
    setInvalidIndices([])
    setSubmitting(true)
    try {
      const { data: trolley, error } = await supabase.from('coating_trolleys')
        .insert({ label: label || null, temp_celsius: temp || null, duration_min: duration || null, notes: notes || null, created_by: userId })
        .select().single()
      if (error) throw error

      const { error: itemsError } = await supabase.from('coating_items').insert(
        lineItems.map(l => ({ trolley_id: trolley.id, category: l.category, shape: l.shape, size: l.size || null, mattress: l.mattress || null, colour: l.colour, pieces: l.pieces, product_id: l.product_id || null, part_id: l.part_id || null }))
      )
      if (itemsError) throw itemsError

      // Piece-level barcode tracking (dual-write). Skip parts.
      const pieceRows: Array<Record<string, unknown>> = []
      for (const l of lineItems) {
        if (l.part_id) continue
        const qty = Number(l.pieces) || 0
        for (let n = 0; n < qty; n++) {
          pieceRows.push({
            product_id: l.product_id || null, category: l.category || null, shape: l.shape || null,
            size: l.size || null, colour: l.colour || null, mattress: l.mattress || null,
            status: 'coated', coating_trolley_id: trolley.id, created_by: userId,
          })
        }
      }

      let createdPieces: LabelPiece[] = []
      if (pieceRows.length) {
        const { data: pieces, error: piecesError } = await supabase.from('pieces').insert(pieceRows).select('barcode, shape, size, colour, mattress')
        if (piecesError) throw piecesError
        createdPieces = (pieces as LabelPiece[]) || []
      }

      // NOTE: photo upload stubbed for now (PhotoUploader not yet ported).
      showToast(`Trolley saved ✓ ${createdPieces.length} label(s) ready`)
      setLastLabels(createdPieces.length ? createdPieces : null)
      setLineItems([]); setLabel(''); setTemp(''); setDuration(''); setNotes('')
      void loadTrolleys()
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

  function renderRow(item: CoatingItem, i: number) {
    return (
      <tr key={item.id || i} style={{ borderTop: '1px solid var(--border)' }}>
        <td style={{ padding: '8px 12px', fontSize: 12, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
          <div>{format(new Date(item.created_at), 'dd MMM yy')}</div>
          <button onClick={() => handleReprint(item.trolley_id)} disabled={reprintingId === item.trolley_id}
            style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 700, background: 'none', border: 'none', cursor: 'pointer', marginTop: 2, opacity: reprintingId === item.trolley_id ? 0.4 : 1 }}
            title="Reprint labels">{reprintingId === item.trolley_id ? '…' : '🏷️'}</button>
        </td>
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

      {tab === 'entry' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <div style={{ background: 'var(--accent)', color: '#fff', borderRadius: 10, padding: '12px 16px', fontSize: 13, fontWeight: 700 }}>
            {format(new Date(), 'EEE, dd MMM yyyy • hh:mm:ss aa')}
          </div>

          <div>
            <div style={sectionTitle}>Frames in this Trolley</div>
            <LineItemList items={lineItems} onRemove={i => { setLineItems(p => p.filter((_, idx) => idx !== i)); setInvalidIndices([]) }} invalidIndices={invalidIndices} />
          </div>

          <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: 16 }}>
            <div style={{ fontWeight: 700, color: 'var(--accent)', fontSize: 13, marginBottom: 12 }}>+ Add Frame</div>
            <FramePicker mode="coating" showColour onAdd={item => setLineItems(p => [...p, item])} />
          </div>

          <div>
            <div style={sectionTitle}>Trolley Details</div>
            <input style={inputField} placeholder="Trolley ID / Label" value={label} onChange={e => setLabel(e.target.value)} />
          </div>

          <div>
            <div style={sectionTitle}>Oven Details <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
              <div style={{ display: 'flex' }}>
                <input type="number" inputMode="decimal" style={{ ...inputField, borderTopRightRadius: 0, borderBottomRightRadius: 0 }} placeholder="Temp" value={temp} onChange={e => setTemp(e.target.value)} />
                <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: 'none', borderTopRightRadius: 10, borderBottomRightRadius: 10, padding: '0 12px', display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text3)' }}>°C</div>
              </div>
              <div style={{ display: 'flex' }}>
                <input type="number" inputMode="numeric" style={{ ...inputField, borderTopRightRadius: 0, borderBottomRightRadius: 0 }} placeholder="Duration" value={duration} onChange={e => setDuration(e.target.value)} />
                <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: 'none', borderTopRightRadius: 10, borderBottomRightRadius: 10, padding: '0 12px', display: 'flex', alignItems: 'center', fontSize: 13, fontWeight: 700, color: 'var(--text3)' }}>min</div>
              </div>
            </div>
          </div>

          <div>
            <div style={sectionTitle}>Notes <span style={{ color: 'var(--text3)', fontSize: 12, fontWeight: 400 }}>(optional)</span></div>
            <textarea style={{ ...inputField, resize: 'none' }} rows={2} value={notes} onChange={e => setNotes(e.target.value)} />
          </div>

          {/* Photo upload — coming soon (PhotoUploader not yet ported) */}
          <div style={{ padding: 12, borderRadius: 10, border: '1px dashed var(--border)', color: 'var(--text3)', fontSize: 12, textAlign: 'center' }}>
            📷 Photo proof upload — coming soon
          </div>

          {lastLabels && lastLabels.length > 0 && (
            <div style={{ background: 'var(--dispatched-bg)', border: '1px solid var(--border)', borderRadius: 14, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--dispatched)' }}>{lastLabels.length} label(s) ready to print</div>
              <div style={{ fontSize: 12, color: 'var(--dispatched)' }}>Share the PDF to whoever prints on the TE244 (email / WhatsApp), or download it.</div>
              <button onClick={handleShareLabels}
                style={{ width: '100%', padding: 12, background: 'var(--dispatched)', color: '#fff', fontWeight: 700, fontSize: 14, borderRadius: 10, border: 'none', cursor: 'pointer' }}>
                📤 Share Labels PDF
              </button>
            </div>
          )}

          <button onClick={handleSubmit} disabled={submitting || !lineItems.length}
            style={{ width: '100%', padding: 14, background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 15, borderRadius: 10, border: 'none', cursor: 'pointer', opacity: (submitting || !lineItems.length) ? 0.4 : 1 }}>
            {submitting ? 'Saving...' : 'Submit Trolley'}
          </button>
        </div>
      )}

      {tab === 'log' && (
        <LogTable isFetching={isFetching} hasData={!!sorted.length} viewMode={viewMode} setViewMode={setViewMode}
          allCollapsed={allCollapsed()} toggleAllDays={toggleAllDays} tableHead={tableHead}
          sorted={sorted} dayGroups={dayGroups} collapsedDays={collapsedDays} toggleDay={toggleDay}
          renderRow={renderRow} totalPcs={totalPcs} colCount={COL_COUNT} emptyIcon="🎨" emptyMsg="No coating entries yet" />
      )}
    </div>
  )
}

// Shared log-table renderer (also used by Picks)
export function LogTable<T extends { id?: string; pieces: number; created_at: string }>({
  isFetching, hasData, viewMode, setViewMode, allCollapsed, toggleAllDays, tableHead,
  sorted, dayGroups, collapsedDays, toggleDay, renderRow, totalPcs, colCount, emptyIcon, emptyMsg,
}: {
  isFetching: boolean; hasData: boolean; viewMode: 'all' | 'day'; setViewMode: (v: 'all' | 'day') => void
  allCollapsed: boolean; toggleAllDays: () => void; tableHead: ReactNode
  sorted: T[]; dayGroups: Array<{ dateKey: string; items: T[]; total: number }>
  collapsedDays: Record<string, boolean>; toggleDay: (k: string) => void
  renderRow: (item: T, i: number) => ReactNode; totalPcs: number; colCount: number
  emptyIcon: string; emptyMsg: string
}) {
  if (isFetching && !hasData) return <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Spinner size="lg" /></div>
  if (!hasData) return <EmptyState icon={emptyIcon} message={emptyMsg} />
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {(['all', 'day'] as const).map(vm => (
            <button key={vm} onClick={() => setViewMode(vm)}
              style={{
                padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: viewMode === vm ? 'none' : '1px solid var(--border)',
                background: viewMode === vm ? 'var(--accent)' : 'var(--surface)', color: viewMode === vm ? '#fff' : 'var(--text3)',
              }}>{vm === 'all' ? 'All Rows' : 'Day View'}</button>
          ))}
        </div>
        {viewMode === 'day' && (
          <button onClick={toggleAllDays}
            style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 700, background: 'var(--surface)', color: 'var(--text3)', border: '1px solid var(--border)', cursor: 'pointer' }}>
            {allCollapsed ? 'Expand All' : 'Collapse All'}
          </button>
        )}
      </div>

      <div style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 14, minWidth: 520, borderCollapse: 'collapse' }}>
          {tableHead}
          {viewMode === 'all' ? (
            <>
              <tbody>{sorted.map((item, i) => renderRow(item, i))}</tbody>
              <tfoot style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)' }}>
                <tr>
                  <td colSpan={colCount - 1} style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>Total ({sorted.length} rows)</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{totalPcs}</td>
                </tr>
              </tfoot>
            </>
          ) : (
            <>
              <tbody>
                {dayGroups.map(group => (
                  <DayRows key={group.dateKey} group={group} collapsed={!!collapsedDays[group.dateKey]} onToggle={() => toggleDay(group.dateKey)} renderRow={renderRow} colCount={colCount} />
                ))}
              </tbody>
              <tfoot style={{ background: 'var(--bg2)', borderTop: '2px solid var(--border)' }}>
                <tr>
                  <td colSpan={colCount - 1} style={{ padding: '8px 12px', fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>Total ({sorted.length} rows, {dayGroups.length} days)</td>
                  <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 800, color: 'var(--accent)' }}>{totalPcs}</td>
                </tr>
              </tfoot>
            </>
          )}
        </table>
      </div>
    </div>
  )
}

function DayRows<T>({ group, collapsed, onToggle, renderRow, colCount }: {
  group: { dateKey: string; items: T[]; total: number }; collapsed: boolean; onToggle: () => void
  renderRow: (item: T, i: number) => ReactNode; colCount: number
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
