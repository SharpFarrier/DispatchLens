'use client'
import { useState, useEffect, useMemo, useCallback, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { DBOrder } from '@/types'
import { Phone, MessageCircle, ChevronDown, ChevronRight, Check } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

const CALLERS = ['Vishaka', 'Priyanka'] as const
const PREDISPATCH_DISPOSITIONS = ['Confirmed', 'Cancelled', 'Hold', 'No answer', 'Call back later', 'WhatsApp-confirmed'] as const
const DELAY_DISPOSITIONS = ['Okay with delay', 'Wants to cancel', 'No answer', 'Call back', 'Escalate'] as const

interface CallLog { id: string; order_id: string; queue: string; channel: string; disposition: string | null; note: string | null; caller: string | null; created_at: string }

// Days left to promised delivery (promise_date − today). Negative = overdue.
function deliveryDaysLeft(o: DBOrder): number | null {
  if (!o.promise_date) return null
  const promise = new Date(o.promise_date + 'T00:00:00').getTime()
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Math.round((promise - today.getTime()) / 86400000)
}

function statusOf(o: DBOrder): { label: string; fg: string; bg: string } {
  if (o.is_cancelled) return { label: 'Cancelled', fg: 'var(--critical)', bg: 'var(--critical-bg)' }
  if (o.tracking_status === 'delivered') return { label: 'Delivered', fg: 'var(--dispatched)', bg: 'var(--dispatched-bg)' }
  if (o.is_dispatched) return { label: 'Dispatched', fg: '#7c3aed', bg: '#f5f3ff' }
  if (o.plan_decision === 'unfulfillable') return { label: 'Hold', fg: 'var(--today)', bg: 'var(--today-bg)' }
  if (o.plan_decision === 'scheduled') return { label: 'Scheduled', fg: '#2563eb', bg: '#eff6ff' }
  return { label: 'Imported', fg: 'var(--text2)', bg: 'var(--bg2)' }
}

export default function CallLensTab({ currentUserEmail }: { currentUserEmail: string }) {
  const supabase = createClient()
  const [orders, setOrders] = useState<DBOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [queue, setQueue] = useState<'predispatch' | 'delay'>('predispatch')
  const [callerFilter, setCallerFilter] = useState<'All' | typeof CALLERS[number]>('All')
  const [logs, setLogs] = useState<Record<string, CallLog[]>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dispDraft, setDispDraft] = useState<Record<string, { disp: string; note: string }>>({})
  const [saving, setSaving] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const rows = await fetchAllRows<DBOrder>((from, to) =>
      supabase.from('dispatch_orders')
        .select('*')
        .eq('is_cancelled', false)
        .order('order_date', { ascending: false }).order('id', { ascending: false }).range(from, to))
    setOrders(rows)
    setLoading(false)
  }, [supabase])
  useEffect(() => { load() }, [load])

  // Queue membership:
  // - predispatch: not dispatched, not cancelled (imported / scheduled / hold)
  // - delay: dispatched, not delivered (running check)
  const queued = useMemo(() => {
    // Statuses that mean the parcel is NOT heading forward to the customer
    // (returning, undelivered-terminal, or already delivered) — excluded from
    // the delay queue, which is only for shipments in transit toward delivery.
    const notInTransit = new Set(['delivered', 'rto', 'returned', 'return to origin', 'rto delivered', 'rto initiated', 'cancelled', 'lost'])
    return orders.filter(o => {
      if (queue === 'predispatch') return !o.is_dispatched && !o.is_cancelled
      // delay: dispatched, still in transit toward the customer (not RTO/returned/delivered)
      const status = (o.tracking_status || '').toLowerCase()
      return o.is_dispatched && !notInTransit.has(status)
    }).filter(o => callerFilter === 'All' ? true : o.assigned_caller === callerFilter)
  }, [orders, queue, callerFilter])

  const dispositions = queue === 'predispatch' ? PREDISPATCH_DISPOSITIONS : DELAY_DISPOSITIONS

  const counts = useMemo(() => {
    const notInTransit = new Set(['delivered', 'rto', 'returned', 'return to origin', 'rto delivered', 'rto initiated', 'cancelled', 'lost'])
    const pre = orders.filter(o => !o.is_dispatched && !o.is_cancelled)
    const del = orders.filter(o => o.is_dispatched && !notInTransit.has((o.tracking_status || '').toLowerCase()))
    const byCaller = (list: DBOrder[], c: string) => list.filter(o => o.assigned_caller === c).length
    return { pre: pre.length, del: del.length,
      v: byCaller(queue === 'predispatch' ? pre : del, 'Vishaka'),
      p: byCaller(queue === 'predispatch' ? pre : del, 'Priyanka') }
  }, [orders, queue])

  const loadLogs = useCallback(async (orderId: string) => {
    const { data } = await supabase.from('call_logs').select('*').eq('order_id', orderId).order('created_at', { ascending: false })
    setLogs(prev => ({ ...prev, [orderId]: (data as CallLog[]) || [] }))
  }, [supabase])

  const toggleExpand = (orderId: string) => {
    if (expanded === orderId) { setExpanded(null); return }
    setExpanded(orderId)
    if (!logs[orderId]) loadLogs(orderId)
  }

  // Apply a disposition: log it + (for confirm/cancel/hold) update the order status.
  const applyDisposition = async (o: DBOrder) => {
    const draft = dispDraft[o.order_id]
    if (!draft || !draft.disp) return
    setSaving(o.order_id)
    try {
      const now = new Date().toISOString()
      await supabase.from('call_logs').insert({
        order_id: o.order_id, queue, channel: 'call',
        disposition: draft.disp, note: draft.note || null,
        caller: o.assigned_caller || null, created_by_email: currentUserEmail,
      })
      // Denormalized last-disposition for quick display.
      const orderPatch: Record<string, unknown> = { last_disposition: draft.disp, last_disposition_at: now, updated_at: now }
      // Disposition → status automation (pre-dispatch queue only).
      if (queue === 'predispatch') {
        if (draft.disp === 'Confirmed' || draft.disp === 'WhatsApp-confirmed') { orderPatch.plan_decision = 'scheduled' }
        else if (draft.disp === 'Cancelled') { orderPatch.is_cancelled = true; orderPatch.manual_cancelled = true; orderPatch.manual_cancelled_at = now }
        else if (draft.disp === 'Hold') { orderPatch.plan_decision = 'unfulfillable' }
      } else {
        if (draft.disp === 'Wants to cancel') { orderPatch.is_cancelled = true; orderPatch.manual_cancelled = true; orderPatch.manual_cancelled_at = now }
      }
      await supabase.from('dispatch_orders').update(orderPatch).eq('order_id', o.order_id)
      // Reflect locally.
      setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, ...orderPatch } as DBOrder : x))
      setDispDraft(prev => { const n = { ...prev }; delete n[o.order_id]; return n })
      if (logs[o.order_id]) loadLogs(o.order_id)
    } finally {
      setSaving(null)
    }
  }

  const setCaller = async (o: DBOrder, caller: string) => {
    await supabase.from('dispatch_orders').update({ assigned_caller: caller, updated_at: new Date().toISOString() }).eq('order_id', o.order_id)
    setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, assigned_caller: caller } as DBOrder : x))
  }

  const toggleWhatsapp = async (o: DBOrder) => {
    const now = new Date().toISOString()
    const next = !o.whatsapp_sent
    await supabase.from('dispatch_orders').update({ whatsapp_sent: next, whatsapp_sent_at: next ? now : null, updated_at: now }).eq('order_id', o.order_id)
    if (next) await supabase.from('call_logs').insert({ order_id: o.order_id, queue, channel: 'whatsapp', disposition: 'WhatsApp sent', caller: o.assigned_caller || null, created_by_email: currentUserEmail })
    setOrders(prev => prev.map(x => x.order_id === o.order_id ? { ...x, whatsapp_sent: next } as DBOrder : x))
    if (logs[o.order_id]) loadLogs(o.order_id)
  }

  const fmtTime = (d: string) => new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const fmtDate = (d: string | null | undefined) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—'

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>CallLens</h1>
        <div style={{ display: 'flex', gap: 3, background: 'var(--bg2)', padding: 3, borderRadius: 7 }}>
          <button onClick={() => setQueue('predispatch')} style={{ padding: '6px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: queue === 'predispatch' ? 'var(--surface)' : 'transparent', color: queue === 'predispatch' ? 'var(--text)' : 'var(--text3)', boxShadow: queue === 'predispatch' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
            Pre-dispatch confirm <b style={{ color: 'var(--accent)' }}>{counts.pre}</b>
          </button>
          <button onClick={() => setQueue('delay')} style={{ padding: '6px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: queue === 'delay' ? 'var(--surface)' : 'transparent', color: queue === 'delay' ? 'var(--text)' : 'var(--text3)', boxShadow: queue === 'delay' ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
            Delay check <b>{counts.del}</b>
          </button>
        </div>
        <div style={{ display: 'flex', gap: 3, background: 'var(--bg2)', padding: 3, borderRadius: 7, marginLeft: 'auto' }}>
          {(['All', 'Vishaka', 'Priyanka'] as const).map(c => (
            <button key={c} onClick={() => setCallerFilter(c)} style={{ padding: '6px 12px', borderRadius: 5, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, background: callerFilter === c ? 'var(--surface)' : 'transparent', color: callerFilter === c ? 'var(--text)' : 'var(--text3)', boxShadow: callerFilter === c ? '0 1px 2px rgba(0,0,0,0.08)' : 'none' }}>
              {c}{c !== 'All' && <b style={{ marginLeft: 5, color: 'var(--text3)' }}>{c === 'Vishaka' ? counts.v : counts.p}</b>}
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...card, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' as const, overflowY: 'auto' as const, maxHeight: 'calc(100vh - 240px)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12, minWidth: 1100 }}>
            <thead style={{ position: 'sticky' as const, top: 0, zIndex: 10 }}>
              <tr style={{ background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
                {(queue === 'delay'
                  ? ['Order', 'Customer', 'Contact', 'Status', 'Promise', 'Dispatched', 'Delivery', 'Caller', 'WA', 'Disposition', '']
                  : ['Order', 'Customer', 'Contact', 'Status', 'Caller', 'WA', 'Disposition', '']
                ).map((h, i) => (
                  <th key={i} style={{ padding: '9px 12px', textAlign: 'left' as const, color: 'var(--text3)', fontSize: 11, fontFamily: 'DM Mono', fontWeight: 500, whiteSpace: 'nowrap' as const, background: 'var(--bg2)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={queue === 'delay' ? 11 : 8} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading…</td></tr>
              ) : queued.length === 0 ? (
                <tr><td colSpan={queue === 'delay' ? 11 : 8} style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)' }}>No orders in this queue.</td></tr>
              ) : queued.map((o, i) => {
                const st = statusOf(o)
                const draft = dispDraft[o.order_id] || { disp: '', note: '' }
                const open = expanded === o.order_id
                return (
                  <Fragment key={o.id}>
                    <tr style={{ borderBottom: open ? 'none' : '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
                      <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, whiteSpace: 'nowrap' as const }}>{o.order_id}</td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.customer_name}</td>
                      <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, whiteSpace: 'nowrap' as const }}>
                        {o.contact_number ? <a href={`tel:${o.contact_number}`} style={{ color: 'var(--accent)', textDecoration: 'none' }}>{o.contact_number}</a> : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                        <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 600, color: st.fg, background: st.bg, padding: '2px 7px', borderRadius: 4 }}>{st.label}</span>
                      </td>
                      {queue === 'delay' && (() => {
                        const dl = deliveryDaysLeft(o)
                        const dlColor = dl === null ? 'var(--text3)' : dl < 0 ? 'var(--critical)' : dl <= 1 ? 'var(--today)' : 'var(--dispatched)'
                        const dlText = dl === null ? '—' : dl < 0 ? `${Math.abs(dl)}d overdue` : dl === 0 ? 'due today' : `${dl}d left`
                        return (
                          <>
                            <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{fmtDate(o.promise_date)}</td>
                            <td style={{ padding: '8px 12px', fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' as const }}>{fmtDate(o.dispatched_at)}</td>
                            <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                              <span style={{ fontSize: 11, fontFamily: 'DM Mono', fontWeight: 700, color: dlColor }}>{dlText}</span>
                            </td>
                          </>
                        )
                      })()}
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                        <select value={o.assigned_caller || ''} onChange={e => setCaller(o, e.target.value)}
                          style={{ fontSize: 11, padding: '3px 6px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer' }}>
                          <option value="">—</option>
                          {CALLERS.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                        <button onClick={() => toggleWhatsapp(o)} title="Toggle WhatsApp sent"
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: o.whatsapp_sent ? '#16a34a' : 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 600 }}>
                          <MessageCircle size={13} /> {o.whatsapp_sent ? 'sent' : '—'}
                        </button>
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <select value={draft.disp} onChange={e => setDispDraft(prev => ({ ...prev, [o.order_id]: { ...draft, disp: e.target.value } }))}
                            style={{ fontSize: 11, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer' }}>
                            <option value="">{o.last_disposition ? `↻ ${o.last_disposition}` : 'Set disposition…'}</option>
                            {dispositions.map(d => <option key={d} value={d}>{d}</option>)}
                          </select>
                          {draft.disp && (
                            <>
                              <input value={draft.note} onChange={e => setDispDraft(prev => ({ ...prev, [o.order_id]: { ...draft, note: e.target.value } }))}
                                placeholder="note…" style={{ fontSize: 11, padding: '4px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', width: 120, outline: 'none' }} />
                              <button onClick={() => applyDisposition(o)} disabled={saving === o.order_id}
                                style={{ padding: '4px 8px', borderRadius: 5, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                                <Check size={11} /> {saving === o.order_id ? '…' : 'Save'}
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '8px 12px', whiteSpace: 'nowrap' as const }}>
                        <button onClick={() => toggleExpand(o.order_id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11 }}>
                          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} log
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg2)' }}>
                        <td colSpan={queue === 'delay' ? 11 : 8} style={{ padding: '4px 12px 14px 34px' }}>
                          {!logs[o.order_id] ? (
                            <span style={{ fontSize: 12, color: 'var(--text3)' }}>Loading history…</span>
                          ) : logs[o.order_id].length === 0 ? (
                            <span style={{ fontSize: 12, color: 'var(--text3)' }}>No calls or messages logged yet.</span>
                          ) : (
                            <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 14, display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                              {logs[o.order_id].map(l => (
                                <div key={l.id} style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: l.channel === 'whatsapp' ? '#16a34a' : 'var(--accent)' }}>
                                    {l.channel === 'whatsapp' ? <MessageCircle size={12} /> : <Phone size={12} />}
                                  </span>
                                  <span style={{ fontFamily: 'DM Mono', fontSize: 11, color: 'var(--text3)' }}>{fmtTime(l.created_at)}</span>
                                  <span style={{ fontWeight: 600 }}>{l.disposition}</span>
                                  {l.note && <span style={{ color: 'var(--text3)' }}>· {l.note}</span>}
                                  {l.caller && <span style={{ color: 'var(--text3)', fontSize: 11 }}>· {l.caller}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
