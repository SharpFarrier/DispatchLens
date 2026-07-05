'use client'
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Search, RotateCcw, Ban, History, X, AlertTriangle } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

// Unified packed-barcode lifecycle. Forward: (coated→) packed → stocked → dispatched → returned.
// Side-exits: void (dead / phantom stock) and error (quarantine, recoverable).
interface PackedUnit {
  id: string; barcode: string; sku: string; seq: number | null; status: string
  source: string | null; piece_id: string | null
  packed_at: string | null; stocked_at: string | null; dispatched_at: string | null
  returned_at: string | null; rto_at: string | null; error_at: string | null; error_reason: string | null
  voided_at: string | null; void_reason: string | null; prev_status: string | null
  created_at: string | null
}
interface UnitEvent { id: string; from_status: string | null; to_status: string; reason: string | null; created_at: string }

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  coated:     { label: 'Coated',     color: 'var(--text2)',      bg: 'var(--bg2)' },
  packed:     { label: 'Packed',     color: 'var(--accent)',     bg: 'var(--accent-bg)' },
  stocked:    { label: 'In Stock',   color: 'var(--dispatched)', bg: 'var(--dispatched-bg)' },
  dispatched: { label: 'Dispatched', color: 'var(--text2)',      bg: 'var(--bg2)' },
  returned:   { label: 'Returned',   color: 'var(--today)',      bg: 'var(--today-bg)' },
  error:      { label: 'Error',      color: 'var(--critical)',   bg: 'var(--critical-bg)' },
  void:       { label: 'Void',       color: 'var(--text3)',      bg: 'var(--bg2)' },
  order_deleted:        { label: 'Order Deleted',      color: 'var(--critical)', bg: 'var(--critical-bg)' },
  dispatched_in_error:  { label: 'Dispatched (error)', color: 'var(--today)',    bg: 'var(--today-bg)' },
  returned_closed:      { label: 'Returned · Closed',  color: 'var(--text3)',    bg: 'var(--bg2)' },
}
const ORDER = ['stocked', 'packed', 'dispatched', 'returned', 'error', 'void', 'coated']

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] || { label: status, color: 'var(--text3)', bg: 'var(--bg2)' }
  return <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.04em', color: m.color, background: m.bg, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' as const }}>{m.label}</span>
}

const fmt = (t: string | null) => t ? new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null

export default function LifecycleTab({ userId, isOwner = false }: { userId: string; isOwner?: boolean }) {
  const supabase = createClient()
  const [units, setUnits] = useState<PackedUnit[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [events, setEvents] = useState<Record<string, UnitEvent[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [voidModal, setVoidModal] = useState<PackedUnit | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [errorModal, setErrorModal] = useState<PackedUnit | null>(null)
  const [errorReason, setErrorReason] = useState('')
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  const flash = (text: string, type: 'success' | 'error' = 'success') => { setMsg({ text, type }); setTimeout(() => setMsg(null), 3500) }

  const load = useCallback(async () => {
    setLoading(true)
    const rows = await fetchAllRows<PackedUnit>((from, to) =>
      supabase.from('packed_units').select('*').order('created_at', { ascending: false }).order('id', { ascending: false }).range(from, to))
    setUnits(rows)
    setLoading(false)
  }, [supabase])

  useEffect(() => { load() }, [load])

  // Status counts for the filter chips.
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    units.forEach(u => { c[u.status] = (c[u.status] || 0) + 1 })
    return c
  }, [units])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return units.filter(u => {
      if (statusFilter && u.status !== statusFilter) return false
      if (q && !u.barcode.toLowerCase().includes(q) && !(u.sku || '').toLowerCase().includes(q)) return false
      return true
    }).slice(0, 500)
  }, [units, query, statusFilter])

  async function toggleExpand(u: PackedUnit) {
    if (expanded === u.id) { setExpanded(null); return }
    setExpanded(u.id)
    if (!events[u.id]) {
      const { data } = await supabase.from('packed_unit_events').select('id, from_status, to_status, reason, created_at').eq('packed_unit_id', u.id).order('created_at')
      setEvents(prev => ({ ...prev, [u.id]: (data as UnitEvent[]) || [] }))
    }
  }

  // Append a history row (dual-write alongside the status column change).
  async function logEvent(u: PackedUnit, from: string, to: string, reason: string | null) {
    await supabase.from('packed_unit_events').insert({ packed_unit_id: u.id, barcode: u.barcode, from_status: from, to_status: to, reason, actor: userId })
  }

  async function doVoid() {
    const u = voidModal
    if (!u) return
    // Rule: void is only for mis-generated / extra / pre-dispatch barcodes.
    // A dispatched unit represents a real shipment and can never be voided.
    if (u.status === 'dispatched') { flash('Cannot void a dispatched barcode — dispatch is final.', 'error'); return }
    if (!voidReason.trim()) { flash('Give a reason for voiding', 'error'); return }
    setBusy(u.id)
    const now = new Date().toISOString()
    const { error } = await supabase.from('packed_units').update({
      status: 'void', prev_status: u.status, voided_at: now, voided_by: userId, void_reason: voidReason.trim(),
    }).eq('id', u.id)
    if (error) { flash('Error: ' + error.message, 'error'); setBusy(null); return }
    await logEvent(u, u.status, 'void', voidReason.trim())
    setUnits(prev => prev.map(x => x.id === u.id ? { ...x, status: 'void', prev_status: u.status, voided_at: now, void_reason: voidReason.trim() } : x))
    setEvents(prev => { const c = { ...prev }; delete c[u.id]; return c })
    flash(`${u.barcode} voided — removed from stock`)
    setVoidModal(null); setVoidReason(''); setBusy(null)
  }

  async function unVoid(u: PackedUnit) {
    setBusy(u.id)
    const back = u.prev_status || 'stocked'
    const now = new Date().toISOString()
    const { error } = await supabase.from('packed_units').update({
      status: back, voided_at: null, voided_by: null, void_reason: null, prev_status: null,
    }).eq('id', u.id)
    if (error) { flash('Error: ' + error.message, 'error'); setBusy(null); return }
    await logEvent(u, 'void', back, 'un-voided')
    setUnits(prev => prev.map(x => x.id === u.id ? { ...x, status: back, void_reason: null, voided_at: null } : x))
    setEvents(prev => { const c = { ...prev }; delete c[u.id]; return c })
    flash(`${u.barcode} restored to ${STATUS_META[back]?.label || back}`)
    setBusy(null)
  }

  // Owner-only correction: a barcode was flagged dispatched but never physically shipped.
  // Closes it to a distinct terminal state (dispatch itself is otherwise final).
  async function markDispatchedInError() {
    const u = errorModal
    if (!u) return
    if (!errorReason.trim()) { flash('Give a reason', 'error'); return }
    setBusy(u.id)
    const now = new Date().toISOString()
    const { error } = await supabase.from('packed_units').update({
      status: 'dispatched_in_error', prev_status: u.status, void_reason: errorReason.trim(), voided_at: now, voided_by: userId,
    }).eq('id', u.id)
    if (error) { flash('Error: ' + error.message, 'error'); setBusy(null); return }
    await logEvent(u, u.status, 'dispatched_in_error', errorReason.trim())
    setUnits(prev => prev.map(x => x.id === u.id ? { ...x, status: 'dispatched_in_error' } : x))
    setEvents(prev => { const c = { ...prev }; delete c[u.id]; return c })
    flash(`${u.barcode} marked dispatched-in-error`)
    setErrorModal(null); setErrorReason(''); setBusy(null)
  }

  // Build the lifecycle timeline from the unit's own timestamps (stable even without event rows).
  function timeline(u: PackedUnit) {
    const steps: { label: string; at: string | null }[] = [
      { label: 'Packed', at: u.packed_at },
      { label: 'Stocked', at: u.stocked_at },
      { label: 'Dispatched', at: u.dispatched_at },
      { label: 'Returned', at: u.returned_at || u.rto_at },
      { label: 'Error', at: u.error_at },
      { label: 'Voided', at: u.voided_at },
    ]
    return steps.filter(s => s.at)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
      {msg && (
        <div style={{ position: 'fixed' as const, bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, padding: '10px 20px', borderRadius: 20, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          background: msg.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)', color: msg.type === 'error' ? 'var(--critical)' : 'var(--dispatched)',
          border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>
      )}

      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Barcode Lifecycle</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 0' }}>Every packed barcode — imported &amp; generated — with its current status and full history.</p>
      </div>

      {/* Status filter chips */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
        <button onClick={() => setStatusFilter(null)} style={chip(statusFilter === null)}>All · {units.length}</button>
        {ORDER.filter(s => counts[s]).map(s => (
          <button key={s} onClick={() => setStatusFilter(statusFilter === s ? null : s)} style={chip(statusFilter === s)}>
            {STATUS_META[s]?.label || s} · {counts[s]}
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
        <Search size={15} style={{ color: 'var(--text3)' }} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search barcode or SKU…"
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', padding: '11px 0', fontSize: 14, color: 'var(--text)', fontFamily: 'DM Mono' }} />
        {query && <button onClick={() => setQuery('')} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text3)', display: 'flex' }}><X size={15} /></button>}
      </div>

      {loading ? (
        <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading barcodes…</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            Showing {filtered.length}{filtered.length === 500 ? '+ (refine search)' : ''} of {units.length}
          </div>
          <div style={{ maxHeight: 600, overflowY: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <tbody>
                {filtered.map(u => (
                  <Fragment key={u.id}>
                    <tr onClick={() => toggleExpand(u)} style={{ borderBottom: expanded === u.id ? 'none' : '1px solid var(--border)', cursor: 'pointer' }}>
                      <td style={{ padding: '9px 12px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontSize: 11, color: 'var(--text3)', transform: expanded === u.id ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
                          <span style={{ fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--text)' }}>{u.barcode}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text3)', marginLeft: 19 }}>{u.sku}{u.source ? ` · ${u.source}` : ''}</div>
                      </td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' as const }}><StatusBadge status={u.status} /></td>
                      <td style={{ padding: '9px 12px', textAlign: 'right' as const, width: 1, whiteSpace: 'nowrap' as const }}>
                        {u.status === 'void' ? (
                          <button disabled={busy === u.id} onClick={e => { e.stopPropagation(); unVoid(u) }} style={actionBtn('var(--accent)')}>
                            <RotateCcw size={12} /> Un-void
                          </button>
                        ) : u.status === 'dispatched' ? (
                          isOwner ? (
                            <button disabled={busy === u.id} onClick={e => { e.stopPropagation(); setErrorModal(u) }} style={actionBtn('var(--today)')} title="Owner-only: mark a barcode that was flagged dispatched but never physically shipped">
                              <AlertTriangle size={12} /> Dispatched in error
                            </button>
                          ) : (
                            <span style={{ fontSize: 11, color: 'var(--text3)' }}>—</span>
                          )
                        ) : (u.status === 'order_deleted' || u.status === 'dispatched_in_error' || u.status === 'returned_closed') ? (
                          <span style={{ fontSize: 11, color: 'var(--text3)' }}>closed</span>
                        ) : (
                          <button disabled={busy === u.id} onClick={e => { e.stopPropagation(); setVoidModal(u); setVoidReason('') }} style={actionBtn('var(--critical)')}>
                            <Ban size={12} /> Void
                          </button>
                        )}
                      </td>
                    </tr>
                    {expanded === u.id && (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                        <td colSpan={3} style={{ padding: '4px 12px 14px 31px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '0.05em', margin: '8px 0 6px' }}>
                            <History size={12} /> Lifecycle
                          </div>
                          {/* Timeline from the unit's own timestamps */}
                          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 14, marginBottom: events[u.id]?.length ? 12 : 0 }}>
                            {timeline(u).length === 0 ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>No timestamps recorded.</span> :
                              timeline(u).map((s, i) => (
                                <div key={i} style={{ fontSize: 11 }}>
                                  <div style={{ color: 'var(--text2)', fontWeight: 600 }}>{s.label}</div>
                                  <div style={{ color: 'var(--text3)', fontFamily: 'DM Mono' }}>{fmt(s.at)}</div>
                                </div>
                              ))}
                          </div>
                          {u.void_reason && <div style={{ fontSize: 11, color: 'var(--critical)', marginBottom: 8 }}>Void reason: {u.void_reason}</div>}
                          {u.error_reason && <div style={{ fontSize: 11, color: 'var(--critical)', marginBottom: 8 }}>Error: {u.error_reason}</div>}
                          {/* Event log if any */}
                          {events[u.id] && events[u.id].length > 0 && (
                            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 3, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                              {events[u.id].map(ev => (
                                <div key={ev.id} style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', gap: 8 }}>
                                  <span style={{ fontFamily: 'DM Mono', color: 'var(--text3)' }}>{fmt(ev.created_at)}</span>
                                  <span>{ev.from_status ? `${ev.from_status} → ` : ''}<b>{ev.to_status}</b>{ev.reason ? ` · ${ev.reason}` : ''}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {filtered.length === 0 && (
                  <tr><td style={{ padding: 32, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No barcodes match.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Void confirmation modal */}
      {voidModal && (
        <div onClick={() => setVoidModal(null)} style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ ...card, padding: 20, maxWidth: 440, width: '100%', display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Void {voidModal.barcode}?</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
              Voiding removes this barcode from inventory permanently — it stops counting as stock and can&apos;t be dispatched. The record is kept (not deleted) with your reason, and an owner can un-void it. Use this when a barcode doesn&apos;t represent real stock (e.g. a mislabelled piece) or the piece is scrapped.
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }}>Reason (required)</div>
              <input value={voidReason} onChange={e => setVoidReason(e.target.value)} autoFocus placeholder="e.g. mislabelled — black barcode on white frame"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setVoidModal(null)} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doVoid} disabled={busy === voidModal.id} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: 'var(--critical)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Void barcode</button>
            </div>
          </div>
        </div>
      )}

      {/* Dispatched-in-error modal (owner-only) */}
      {errorModal && (
        <div onClick={() => setErrorModal(null)} style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ ...card, padding: 20, maxWidth: 440, width: '100%', display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Mark {errorModal.barcode} dispatched-in-error?</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>
              Use this ONLY when a barcode was flagged dispatched but never physically shipped (e.g. a double-dispatch that wasn&apos;t loaded). It closes this barcode to a distinct terminal state so the mistake is traceable. Dispatch is otherwise final — this is not a general un-dispatch. The record is kept and stays searchable.
            </div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 6 }}>Reason (required)</div>
              <input value={errorReason} onChange={e => setErrorReason(e.target.value)} autoFocus placeholder="e.g. double-dispatched — parcel never loaded"
                style={{ width: '100%', padding: '10px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' as const }} />
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setErrorModal(null)} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 500, cursor: 'pointer' }}>Cancel</button>
              <button onClick={markDispatchedInError} disabled={busy === errorModal.id} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: 'var(--today)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Mark in error</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function chip(active: boolean) {
  return { padding: '5px 11px', borderRadius: 16, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent)' : 'var(--surface)', color: active ? '#fff' : 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const } as const
}
function actionBtn(color: string) {
  return { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: `1px solid ${color}`, background: 'var(--surface)', color, fontSize: 11, fontWeight: 600, cursor: 'pointer' } as const
}
