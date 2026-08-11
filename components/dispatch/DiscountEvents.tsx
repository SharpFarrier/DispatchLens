'use client'
import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Plus, Trash2, ChevronRight, Tag } from 'lucide-react'

interface EventSku { id: string; sku: string; discount_pct: number }
interface DiscEvent { id: string; name: string; platform: string; start_date: string; end_date: string; skus: EventSku[] }
const PLATFORMS = ['Amazon', 'Flipkart', 'Website', 'Both'] as const

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }
const input = { padding: '7px 9px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 12, outline: 'none', boxSizing: 'border-box' as const }
const fmtDate = (s: string) => s ? new Date(s + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const platColor = (p: string) => p === 'Amazon' ? { fg: '#b45309', bg: '#fef3c7' } : p === 'Flipkart' ? { fg: '#2563eb', bg: '#eff6ff' } : p === 'Website' ? { fg: '#7c3aed', bg: '#f5f3ff' } : { fg: 'var(--text2)', bg: 'var(--bg2)' }

export default function DiscountEvents() {
  const supabase = createClient()
  const [events, setEvents] = useState<DiscEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [ev, setEv] = useState({ name: '', platform: 'Both', start: '', end: '' })
  const [skuDraft, setSkuDraft] = useState<Record<string, { sku: string; pct: string }>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: evs } = await supabase.from('recon_discount_events').select('*').order('start_date', { ascending: false })
      const { data: sks } = await supabase.from('recon_discount_event_skus').select('*')
      const byEvent: Record<string, EventSku[]> = {}
      for (const s of (sks || []) as Record<string, unknown>[]) {
        const eid = String(s.event_id)
        ;(byEvent[eid] ??= []).push({ id: String(s.id), sku: String(s.sku ?? ''), discount_pct: Number(s.discount_pct ?? 0) })
      }
      setEvents((evs || []).map((e: Record<string, unknown>) => ({
        id: String(e.id), name: String(e.name ?? ''), platform: String(e.platform ?? 'Both'),
        start_date: String(e.start_date ?? ''), end_date: String(e.end_date ?? ''), skus: byEvent[String(e.id)] || [],
      })))
    } catch (e) { setMsg({ ok: false, text: 'Load failed: ' + (e as Error).message }) }
    setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const addEvent = async () => {
    const name = ev.name.trim()
    if (!name) { setMsg({ ok: false, text: 'Name the event.' }); return }
    if (!ev.start || !ev.end) { setMsg({ ok: false, text: 'Set start and end dates.' }); return }
    if (ev.end < ev.start) { setMsg({ ok: false, text: 'End date is before start date.' }); return }
    setSaving(true); setMsg(null)
    try {
      const { error } = await supabase.from('recon_discount_events').insert({ name, platform: ev.platform, start_date: ev.start, end_date: ev.end })
      if (error) throw error
      setMsg({ ok: true, text: `Added event "${name}".` })
      setEv({ name: '', platform: 'Both', start: '', end: '' })
      void load()
    } catch (e) { setMsg({ ok: false, text: 'Add failed: ' + (e as Error).message }) }
    setSaving(false)
  }

  const deleteEvent = async (id: string) => {
    setMsg(null)
    const { error } = await supabase.from('recon_discount_events').delete().eq('id', id)  // cascades to SKUs
    if (error) { setMsg({ ok: false, text: 'Delete failed: ' + error.message }); return }
    setEvents(prev => prev.filter(e => e.id !== id))
  }

  const addSku = async (eventId: string) => {
    const d = skuDraft[eventId] || { sku: '', pct: '' }
    const sku = d.sku.trim(); const pct = parseFloat(d.pct)
    if (!sku) { setMsg({ ok: false, text: 'Enter a SKU (or __ALL__ for every SKU).' }); return }
    if (isNaN(pct)) { setMsg({ ok: false, text: 'Enter a discount %.' }); return }
    setMsg(null)
    const { error } = await supabase.from('recon_discount_event_skus').insert({ event_id: eventId, sku, discount_pct: pct })
    if (error) { setMsg({ ok: false, text: 'Add failed: ' + error.message }); return }
    setSkuDraft(prev => ({ ...prev, [eventId]: { sku: '', pct: '' } }))
    void load()
  }

  const deleteSku = async (id: string, eventId: string) => {
    const { error } = await supabase.from('recon_discount_event_skus').delete().eq('id', id)
    if (error) { setMsg({ ok: false, text: 'Delete failed: ' + error.message }); return }
    setEvents(prev => prev.map(e => e.id === eventId ? { ...e, skus: e.skus.filter(s => s.id !== id) } : e))
  }

  return (
    <div style={{ maxWidth: 1000, display: 'flex', flexDirection: 'column' as const, gap: 18 }}>
      <div>
        <h2 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 4px' }}>Discount events</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0 }}>Time-boxed promotions that override the base price. During an event, an order&apos;s expected price becomes base × (1 − discount%). Use SKU <code style={{ background: 'var(--bg2)', padding: '1px 5px', borderRadius: 4 }}>__ALL__</code> to discount every SKU in the event.</p>
      </div>

      {msg && <div style={{ borderRadius: 8, padding: '10px 14px', fontSize: 13, fontWeight: 600, border: `1px solid ${msg.ok ? '#bbf7d0' : '#fecaca'}`, background: msg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', color: msg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>{msg.text}</div>}

      {/* Add event */}
      <div style={{ ...card, padding: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Add an event</div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Name</span><input value={ev.name} onChange={e => setEv(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Great Indian Festival" style={{ ...input, width: 240 }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Platform</span><select value={ev.platform} onChange={e => setEv(p => ({ ...p, platform: e.target.value }))} style={{ ...input, cursor: 'pointer' }}>{PLATFORMS.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>Start</span><input type="date" value={ev.start} onChange={e => setEv(p => ({ ...p, start: e.target.value }))} style={{ ...input }} /></label>
          <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}><span style={{ fontSize: 11, color: 'var(--text2)', fontWeight: 600 }}>End</span><input type="date" value={ev.end} onChange={e => setEv(p => ({ ...p, end: e.target.value }))} style={{ ...input }} /></label>
          <button onClick={addEvent} disabled={saving} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: saving ? 'var(--bg2)' : 'var(--accent)', color: saving ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 700, cursor: saving ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}><Plus size={14} /> Add event</button>
        </div>
      </div>

      {/* Events list */}
      {loading ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>Loading…</div>
      ) : !events.length ? (
        <div style={{ ...card, padding: 24, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No discount events yet — add one above.</div>
      ) : events.map(e => {
        const c = platColor(e.platform); const isOpen = open[e.id] ?? false; const d = skuDraft[e.id] || { sku: '', pct: '' }
        return (
          <div key={e.id} style={{ ...card, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }} onClick={() => setOpen(p => ({ ...p, [e.id]: !isOpen }))}>
              <span style={{ display: 'inline-flex', transition: 'transform .15s', transform: isOpen ? 'rotate(90deg)' : 'none' }}><ChevronRight size={15} /></span>
              <Tag size={14} style={{ color: 'var(--text3)' }} />
              <span style={{ fontWeight: 700, fontSize: 14 }}>{e.name}</span>
              <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, color: c.fg, background: c.bg, padding: '2px 7px', borderRadius: 4 }}>{e.platform}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{fmtDate(e.start_date)} → {fmtDate(e.end_date)}</span>
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>· {e.skus.length} SKU{e.skus.length === 1 ? '' : 's'}</span>
              <button onClick={ev2 => { ev2.stopPropagation(); if (confirm(`Delete event "${e.name}" and its ${e.skus.length} SKU discount(s)?`)) void deleteEvent(e.id) }} title="Delete event" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={15} /></button>
            </div>
            {isOpen && (
              <div style={{ borderTop: '1px solid var(--border)', padding: 14 }}>
                {e.skus.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 12 }}>
                    {e.skus.map(s => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg2)', borderRadius: 6, padding: '6px 10px' }}>
                        <span style={{ fontFamily: 'DM Mono', fontSize: 12, color: s.sku === '__ALL__' ? 'var(--accent)' : 'var(--text)', fontWeight: s.sku === '__ALL__' ? 700 : 400 }}>{s.sku === '__ALL__' ? 'All SKUs' : s.sku}</span>
                        <span style={{ fontFamily: 'DM Mono', fontSize: 12, fontWeight: 700, color: 'var(--today)' }}>{s.discount_pct}% off</span>
                        <button onClick={() => deleteSku(s.id, e.id)} title="Remove" style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 2, display: 'inline-flex' }}><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
                  <input value={d.sku} onChange={ch => setSkuDraft(p => ({ ...p, [e.id]: { ...d, sku: ch.target.value } }))} placeholder="SKU or __ALL__" style={{ ...input, width: 200, fontFamily: 'DM Mono' }} />
                  <input value={d.pct} onChange={ch => setSkuDraft(p => ({ ...p, [e.id]: { ...d, pct: ch.target.value } }))} inputMode="decimal" placeholder="Discount %" style={{ ...input, width: 110, fontFamily: 'DM Mono' }} />
                  <button onClick={() => addSku(e.id)} style={{ padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Plus size={13} /> Add SKU discount</button>
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
