'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { AlertTriangle, Download, Plus, Minus, CheckCircle, ExternalLink, ChevronDown, ChevronRight } from 'lucide-react'
import type { DBOrder } from '@/types'
import WheelDatePicker from './WheelDatePicker'

interface DelayRow {
  o: DBOrder
  aging: number
  reminders: number
  lastBump: { at: string; by: string | null } | null
}
interface ActionEntry { id: number; order_id: string; action: string; at: string; by_email: string | null }

const notInTransit = new Set(['delivered', 'rto', 'returned', 'cancelled', 'lost'])
const daysSince = (iso: string | null): number => {
  if (!iso) return 0
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).getTime()
  return Math.max(0, Math.floor((Date.now() - d) / 86400000))
}
const fmtDay = (iso: string | null) => iso ? new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'

export default function DelaysTab({ orders, userEmail, onOrderUpdate }: {
  orders: DBOrder[]; userEmail?: string; onOrderUpdate?: (orderId: string, patch: Partial<DBOrder>) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [threshold, setThreshold] = useState(7)
  const [delayMap, setDelayMap] = useState<Record<string, { reminders: number; lastBump: { at: string; by: string | null } | null }>>({})
  const [actions, setActions] = useState<Record<string, ActionEntry[]>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [showDelivered, setShowDelivered] = useState(false)
  const [markDeliver, setMarkDeliver] = useState<DBOrder | null>(null)
  const [markDate, setMarkDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [markSaving, setMarkSaving] = useState(false)

  const confirmMarkDelivered = async () => {
    if (!markDeliver) return
    setMarkSaving(true)
    try {
      const o = markDeliver
      await supabase.from('dispatch_orders').update({ tracking_status: 'delivered', delivered_at: markDate, manual_delivered_at: new Date().toISOString(), delivery_source: 'manual' }).eq('order_id', o.order_id)
      onOrderUpdate?.(o.order_id, { tracking_status: 'delivered', delivered_at: markDate, delivery_source: 'manual' } as Partial<DBOrder>)
      setMarkDeliver(null); setMarkDate(new Date().toISOString().slice(0, 10))
    } finally { setMarkSaving(false) }
  }

  const load = useCallback(async () => {
    const [dRows, aRows] = await Promise.all([
      fetchAllRows<{ order_id: string; reminder_count: number; updated_at: string; updated_by: string | null }>((from, to) =>
        supabase.from('order_delays').select('order_id, reminder_count, updated_at, updated_by').range(from, to)),
      fetchAllRows<ActionEntry>((from, to) =>
        supabase.from('order_delay_actions').select('id, order_id, action, at, by_email').order('at', { ascending: true }).range(from, to)),
    ])
    const dm: Record<string, { reminders: number; lastBump: { at: string; by: string | null } | null }> = {}
    for (const r of dRows) dm[r.order_id] = { reminders: r.reminder_count, lastBump: { at: r.updated_at, by: r.updated_by } }
    setDelayMap(dm)
    const am: Record<string, ActionEntry[]> = {}
    for (const a of aRows) { (am[a.order_id] ||= []).push(a) }
    setActions(am)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  // Delayed = dispatched, not delivered/rto, aging >= threshold. Delivered (was delayed, now
  // delivered) shown greyed + collapsed when toggled on.
  const { active, delivered } = useMemo(() => {
    const act: DelayRow[] = []; const del: DelayRow[] = []
    for (const o of orders) {
      if (!o.is_dispatched || o.is_cancelled) continue
      const st = (o.tracking_status || '').toLowerCase()
      const aging = daysSince(o.dispatched_at || o.order_date)
      const d = delayMap[o.order_id]
      const row: DelayRow = { o, aging, reminders: d?.reminders ?? 0, lastBump: d?.lastBump ?? null }
      const everEscalated = !!d
      if (st === 'delivered') { if (everEscalated) del.push(row); continue }
      if (aging >= threshold) act.push(row)
    }
    act.sort((a, b) => b.aging - a.aging)
    del.sort((a, b) => b.aging - a.aging)
    return { active: act, delivered: del }
  }, [orders, delayMap, threshold])

  const totalReminders = useMemo(() => active.reduce((s, r) => s + r.reminders, 0), [active])

  const bumpReminder = async (oid: string, delta: number) => {
    const cur = delayMap[oid]?.reminders ?? 0
    const next = Math.max(0, cur + delta)
    const now = new Date().toISOString()
    setDelayMap(prev => ({ ...prev, [oid]: { reminders: next, lastBump: { at: now, by: userEmail || null } } }))
    await supabase.from('order_delays').upsert({ order_id: oid, reminder_count: next, updated_at: now, updated_by: userEmail || null }, { onConflict: 'order_id' })
    if (delta > 0) {
      const entry = { order_id: oid, action: `Reminder ${next} sent to courier`, at: now, by_email: userEmail || null }
      const { data } = await supabase.from('order_delay_actions').insert(entry).select('id').maybeSingle()
      setActions(prev => ({ ...prev, [oid]: [...(prev[oid] || []), { id: (data?.id as number) ?? Date.now(), ...entry }] }))
    }
  }

  const addAction = async (oid: string) => {
    const text = (draft[oid] || '').trim(); if (!text) return
    const now = new Date().toISOString()
    const entry = { order_id: oid, action: text, at: now, by_email: userEmail || null }
    setDraft(prev => ({ ...prev, [oid]: '' }))
    const { data } = await supabase.from('order_delay_actions').insert(entry).select('id').maybeSingle()
    setActions(prev => ({ ...prev, [oid]: [...(prev[oid] || []), { id: (data?.id as number) ?? Date.now(), ...entry }] }))
    // ensure a delay record exists so the order stays tracked
    if (!delayMap[oid]) { setDelayMap(prev => ({ ...prev, [oid]: { reminders: 0, lastBump: null } })); await supabase.from('order_delays').upsert({ order_id: oid, reminder_count: 0, updated_at: now, updated_by: userEmail || null }, { onConflict: 'order_id' }) }
  }

  const exportCsv = () => {
    const esc = (v: string | number) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t }
    const head = ['Order ID', 'Buyer', 'Contact', 'Address', 'Pincode', 'City', 'State', 'AWB', 'Dispatch date', 'Aging', 'Reminders', 'Tracking', 'Last actions']
    const lines = [head.join(',')]
    for (const r of active) {
      const acts = (actions[r.o.order_id] || []).slice(-3).map(a => `${fmtDay(a.at)}: ${a.action}`).join(' | ')
      lines.push([r.o.order_id, r.o.customer_name || '', r.o.contact_number || '', r.o.ship_address || '', r.o.pincode || '', r.o.city || '', r.o.state || '', r.o.tracking_number || '', fmtDay(r.o.dispatched_at), r.aging, r.reminders, r.o.tracking_status || 'in transit', acts].map(esc).join(','))
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `delays-${new Date().toISOString().slice(0, 10)}.csv`; a.click()
  }

  const statusPill = (st: string | null) => {
    const s = (st || 'in transit').toLowerCase()
    const c = s === 'delivered' ? { fg: 'var(--dispatched)', bg: 'var(--dispatched-bg)' } : notInTransit.has(s) ? { fg: 'var(--critical)', bg: 'var(--critical-bg)' } : { fg: 'var(--today)', bg: 'var(--today-bg)' }
    return <span style={{ fontSize: 11, color: c.fg, background: c.bg, padding: '2px 8px', borderRadius: 5, whiteSpace: 'nowrap' as const }}>{st || 'in transit'}</span>
  }

  const GRID = '170px 1fr 110px 56px 60px 100px 20px'

  const renderRow = (r: DelayRow, greyed = false) => {
    const oid = r.o.order_id
    const isOpen = open === oid
    const log = actions[oid] || []
    return (
      <div key={oid} style={{ borderTop: '1px solid var(--border)', background: isOpen ? 'var(--bg2)' : 'transparent', opacity: greyed ? 0.6 : 1 }}>
        <div onClick={() => setOpen(isOpen ? null : oid)} style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, alignItems: 'center', padding: '11px 14px', cursor: 'pointer' }}>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{oid}</span>
          <div style={{ minWidth: 0 }}><div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{r.o.customer_name || '—'}</div><div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.o.city || ''} · {r.o.pincode || ''}</div></div>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>{r.o.tracking_number || '—'}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: r.aging >= threshold * 2 ? 'var(--critical)' : 'var(--today)' }}>{r.aging}d</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{r.reminders}</span>
          {statusPill(r.o.tracking_status)}
          <span style={{ color: 'var(--text3)' }}>{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
        </div>
        {isOpen && !greyed && (
          <div style={{ padding: '4px 14px 16px', display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', marginBottom: 8 }}>Action log</div>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 7, maxHeight: 200, overflowY: 'auto' as const }} className="no-scrollbar">
                {log.length === 0 ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>No actions logged yet.</span> : log.map(a => (
                  <div key={a.id} style={{ display: 'flex', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' as const }}>{fmtDay(a.at)}</span>
                    <span style={{ fontSize: 12 }}>{a.action}{a.by_email ? <span style={{ color: 'var(--text3)' }}> · {a.by_email.split('@')[0]}</span> : null}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input value={draft[oid] || ''} onChange={e => setDraft(prev => ({ ...prev, [oid]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter') void addAction(oid) }} placeholder="Add an action or note" style={{ flex: 1, padding: '7px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, outline: 'none' }} />
                <button onClick={() => void addAction(oid)} style={{ padding: '7px 14px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Add</button>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', marginBottom: 8 }}>Reminders to courier</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 12 }}>
                <button onClick={() => void bumpReminder(oid, -1)} style={{ width: 32, height: 32, padding: 0, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer' }}><Minus size={15} /></button>
                <span style={{ fontSize: 24, fontWeight: 600, fontFamily: 'var(--font-mono)', minWidth: 28, textAlign: 'center' as const }}>{r.reminders}</span>
                <button onClick={() => void bumpReminder(oid, 1)} style={{ width: 32, height: 32, padding: 0, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer' }}><Plus size={15} /></button>
                {r.lastBump && <span style={{ fontSize: 11, color: 'var(--text3)' }}>last · {fmtDay(r.lastBump.at)}{r.lastBump.by ? ` by ${r.lastBump.by.split('@')[0]}` : ''}</span>}
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
                {<button onClick={() => { setMarkDate(new Date().toISOString().slice(0, 10)); setMarkDeliver(r.o) }} style={{ flex: 1, padding: '8px', borderRadius: 7, border: '1px solid var(--dispatched)', background: 'var(--surface)', color: 'var(--dispatched)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}><CheckCircle size={14} /> Mark delivered</button>}
                {r.o.tracking_number && <a href={`https://www.google.com/search?q=${encodeURIComponent(r.o.tracking_number + ' tracking')}`} target="_blank" rel="noreferrer" style={{ flex: 1, padding: '8px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4, textDecoration: 'none' }}><ExternalLink size={14} /> Track</a>}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  const deliverModal = markDeliver ? (
    <div onClick={() => !markSaving && setMarkDeliver(null)} style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', padding: 20, width: 320, maxWidth: '100%' }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Mark delivered</div>
        <div style={{ fontSize: 12.5, color: 'var(--text2)', marginBottom: 14 }}>Order <span style={{ fontFamily: 'var(--font-mono)' }}>{markDeliver.order_id}</span> — pick the delivery date.</div>
        <WheelDatePicker value={markDate} onChange={setMarkDate} />
        <div style={{ fontSize: 12.5, color: 'var(--text2)', margin: '14px 0 12px' }}>Mark this order delivered on <b>{new Date(markDate + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</b>? This overrides courier tracking.</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={() => setMarkDeliver(null)} disabled={markSaving} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
          <button onClick={confirmMarkDelivered} disabled={markSaving} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: 'var(--dispatched)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>{markSaving ? 'Saving…' : 'Confirm delivered'}</button>
        </div>
      </div>
    </div>
  ) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
      {deliverModal}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0, display: 'inline-flex', alignItems: 'center', gap: 8 }}><AlertTriangle size={17} style={{ color: 'var(--today)' }} /> Delays</h1>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--today)', background: 'var(--today-bg)', padding: '2px 9px', borderRadius: 20 }}>{active.length} delayed · {totalReminders} reminders sent</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>Show aging ≥</span>
          <input type="number" min={0} value={threshold} onChange={e => setThreshold(Math.max(0, Number(e.target.value) || 0))} style={{ width: 56, padding: '6px 8px', textAlign: 'center' as const, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13 }} />
          <span style={{ fontSize: 12, color: 'var(--text2)' }}>days</span>
          <button onClick={exportCsv} disabled={!active.length} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: active.length ? 'var(--text2)' : 'var(--text3)', fontSize: 12, fontWeight: 700, cursor: active.length ? 'pointer' : 'not-allowed', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export</button>
        </div>
      </div>

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' as const }}>
        <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '8px 14px', background: 'var(--bg2)', fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>
          <span>Order</span><span>Buyer · city</span><span>AWB</span><span>Aging</span><span>Rem.</span><span>Status</span><span />
        </div>
        {active.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No delayed orders at aging ≥ {threshold} days.</div>
        ) : active.map(r => renderRow(r))}
      </div>

      {delivered.length > 0 && (
        <div>
          <button onClick={() => setShowDelivered(v => !v)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', color: 'var(--text3)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '4px 0' }}>
            {showDelivered ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Delivered ({delivered.length}) — resolved
          </button>
          {showDelivered && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' as const, marginTop: 6 }}>
              {delivered.map(r => renderRow(r, true))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
