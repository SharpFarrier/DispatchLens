'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { format } from 'date-fns'
import { ColourDot, Th } from './warehouse-ui'
import { useSort, useDayGroups } from './warehouse-hooks'
import { useProductStore } from './useProductStore'
import FramePicker, { type FrameItem } from './FramePicker'
import LineItemList, { getItemErrors } from './LineItemList'
import PickScanTerminal from './PickScanTerminal'
import { LogTable } from './CoatingTab'

const TABS = ['scan', 'entry', 'log'] as const
const COL_COUNT = 6

interface PickItem {
  id?: string; shape: string; size: string | null; mattress: string | null
  colour: string; pieces: number; session_label: string | null; created_at: string; [k: string]: unknown
}

const sectionTitle = { fontSize: 13, fontWeight: 600, color: 'var(--text2)', marginBottom: 8 }
const inputField = { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 14, boxSizing: 'border-box' as const }

export default function PicksTab({ userId }: { userId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const { getBomForProduct } = useProductStore()
  const [tab, setTab] = useState<'scan' | 'entry' | 'log'>('scan')
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
    const { data } = await supabase
      .from('pick_sessions')
      .select('*, pick_items(*)')
      .neq('status', 'deleted')
      .order('created_at', { ascending: false })
      .limit(200)
    setSessions(data || [])
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
        <PickScanTerminal userId={userId} onToast={showToast} onSessionClosed={() => { /* refresh handled on log open */ }} />
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
