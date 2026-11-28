'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Spinner, EmptyState } from './warehouse-ui'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Truck, Package, AlertTriangle, CheckCircle, Download, X, Plus, ClipboardList } from 'lucide-react'
import { buildSkuLookup, resolveBarcodeSku } from '@/lib/skuResolver'
import type { SkuMap } from '@/types'

// Private transport dispatch — a self-contained lane for orders that ship by a private
// vehicle/tempo (no courier, no AWB). The physical box-barcode scan still does the stock
// deduction (same safe-check as the courier terminal); the order is pulled up by Order ID
// instead of AWB. Dispatched private orders then wait in the Awaiting-Delivery queue for a
// one-tap manual delivery confirmation (there is no courier tracking to auto-close them).

type Row = {
  id: string
  order_id: string
  customer_name: string
  city: string | null
  sku: string
  barcode_sku: string | null
  qty: number
  courier: string
  tracking_number: string | null
  tracking_status: string | null
  is_cancelled: boolean
  is_dispatched: boolean
  plan_decision: string | null
  confirmation_status: string | null
  dispatch_method: string | null
  transporter: string | null
  lr_number: string | null
  dispatched_at: string | null
  delivered_at: string | null
  delivered_by: string | null
}

const SELECT = 'id, order_id, customer_name, city, sku, barcode_sku, qty, courier, tracking_number, tracking_status, is_cancelled, is_dispatched, plan_decision, confirmation_status, dispatch_method, transporter, lr_number, dispatched_at, delivered_at, delivered_by'

const isHeld = (o: { confirmation_status: string | null; plan_decision: string | null }) =>
  o.confirmation_status === 'hold' || o.plan_decision === 'hold'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14 }
const inputStyle = { width: '100%', padding: '11px 14px', borderRadius: 8, border: '1px solid var(--accent)', background: 'var(--bg)', color: 'var(--text)', fontSize: 15, fontFamily: 'var(--font-mono)', outline: 'none', boxSizing: 'border-box' as const }
const fieldStyle = { ...inputStyle, border: '1px solid var(--border)' }
const labelStyle = { display: 'block', fontSize: 11, color: 'var(--text2)', marginBottom: 6, fontWeight: 600, fontFamily: 'var(--font-mono)' as const }

function logEvent(order_id: string, event_type: string, title: string, note?: string) {
  fetch('/api/events', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order_id, event_type, title, note: note ?? null }),
  }).catch(() => {})
}

export default function PrivateTab({ currentUserEmail }: { currentUserEmail: string | null }) {
  const supabase = useMemo(() => createClient(), [])

  // ── dispatch scanner state ──
  const [orderInput, setOrderInput] = useState('')
  const [order, setOrder] = useState<Row | null>(null)
  const [pendingRows, setPendingRows] = useState<Row[]>([])   // every un-dispatched line (SKU) of the scanned order
  const [stage, setStage] = useState<'scan' | 'confirm' | 'box'>('scan')
  const [transporter, setTransporter] = useState('')
  const [lr, setLr] = useState('')
  const [boxInput, setBoxInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [forceId, setForceId] = useState<string | null>(null)  // box barcode awaiting force-dispatch
  const [success, setSuccess] = useState<{ sku: string; remaining: number } | null>(null)

  const resetScan = () => {
    setOrderInput(''); setOrder(null); setPendingRows([]); setStage('scan'); setTransporter(''); setLr('')
    setBoxInput(''); setErr(null); setForceId(null)
  }

  const lookupOrder = async (raw: string) => {
    const oid = raw.trim().replace(/\.0+$/, '')
    if (!oid) return
    setErr(null); setSuccess(null); setBusy(true)
    const { data } = await supabase.from('dispatch_orders').select(SELECT).eq('order_id', oid)
    const rows = (data || []) as Row[]
    setBusy(false)
    if (!rows.length) { beepError(); setErr(`No order found for ID ${oid}.`); return }
    const pending = rows.filter(x => !x.is_cancelled && !x.is_dispatched)
    if (!pending.length && rows.some(o => o.is_dispatched && !o.is_cancelled)) { beepError(); setErr(`${oid} is already dispatched — not dispatching again.`); return }
    if (rows.length && rows.every(o => o.is_cancelled)) { beepError(); setErr(`${oid} is cancelled — un-cancel it in Plan first if this is wrong.`); return }
    const held = rows.find(o => isHeld(o))
    if (held) { beepError(); setErr(`${oid} is On Hold — release it in the Plan tab before dispatching.`); return }
    const o = pending[0]
    if (!o) { beepError(); setErr(`No pending order to dispatch for ${oid}.`); return }
    const tracked = pending.find(x => (x.tracking_number || '').trim())
    if (tracked) {
      beepWarn()
      setErr(`${oid} has a tracking ID (${tracked.tracking_number}) — dispatch it from the courier scanner, not the private lane.`)
      return
    }
    beepSuccess()
    setPendingRows(pending)
    setOrder(o); setTransporter(o.transporter || ''); setLr(o.lr_number || ''); setStage('confirm')
  }

  const scanBox = async (rawBarcode: string, force = false) => {
    const barcode = rawBarcode.trim()
    if (!barcode || !order) return
    setErr(null); setBusy(true)
    let deductedSku: string | null = null
    let target: Row = order

    if (!force) {
      const { data: unit } = await supabase.from('packed_units').select('id, sku, status').eq('barcode', barcode).maybeSingle()
      if (!unit) {
        setBusy(false); beepError(); setForceId(barcode)
        setErr(`${barcode} isn't in stock / not found. Force-dispatch it anyway, or rescan.`)
        return
      }
      const u = unit as { id: string; sku: string | null; status: string }
      if (!['stocked', 'picked'].includes(u.status)) {
        setBusy(false); beepError(); setForceId(barcode)
        setErr(`${barcode} is "${u.status}", not in stock. Force-dispatch it anyway, or rescan.`)
        return
      }
      const lines = pendingRows.length ? pendingRows : [order]
      const match = lines.find(r => r.barcode_sku && u.sku && r.barcode_sku === u.sku) || lines.find(r => !r.barcode_sku)
      if (!match) {
        setBusy(false); beepError()
        setErr(`WRONG ITEM — expected ${lines.map(r => r.barcode_sku).filter(Boolean).join(' or ')}, scanned ${u.sku}. Not dispatched.`)
        return
      }
      target = match
      await supabase.from('packed_units').update({ status: 'dispatched', dispatched_at: new Date().toISOString() }).eq('id', u.id).in('status', ['stocked', 'picked'])
      deductedSku = u.sku
    }

    const now = new Date().toISOString()
    const { data: updated, error } = await supabase.from('dispatch_orders').update({
      is_dispatched: true, dispatched_at: now, scan_verified: true, scan_verified_at: now,
      scanned_barcode: barcode, dispatch_method: 'private',
      transporter: transporter.trim() || null, lr_number: lr.trim() || null, updated_at: now,
    }).eq('id', target.id).eq('is_dispatched', false).select(SELECT)
    setBusy(false)

    if (error || !updated || !updated.length) {
      beepError(); setErr('That order was already dispatched — not counting it again.'); return
    }
    if (deductedSku) {
      const { count } = await supabase.from('packed_units').select('id', { count: 'exact', head: true }).eq('sku', deductedSku).eq('status', 'stocked')
      setSuccess({ sku: deductedSku, remaining: count ?? 0 })
    } else {
      setSuccess({ sku: target.barcode_sku || target.sku || '—', remaining: -1 })
    }
    beepSuccess()
    logEvent(order.order_id, 'dispatched', `Private dispatch · box ${barcode}${force ? ' (FORCE — not in stock)' : ''}${transporter.trim() ? ` · ${transporter.trim()}` : ''}`)
    const left = pendingRows.filter(r => r.id !== target.id)
    if (left.length) {
      // more SKUs on this order — stay on it and wait for the next box
      setPendingRows(left); setOrder(left[0]); setBoxInput(''); setForceId(null); setStage('box')
    } else {
      resetScan()
    }
    void loadQueue()
  }

  // ── awaiting-delivery queue ──
  const [queueTab, setQueueTab] = useState<'awaiting' | 'delivered' | 'all'>('awaiting')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(false)
  const [deliveringId, setDeliveringId] = useState<string | null>(null)

  const loadQueue = useCallback(async () => {
    setLoading(true)
    const data = await fetchAllRows<Row>((from, to) =>
      supabase.from('dispatch_orders').select(SELECT).eq('dispatch_method', 'private').eq('is_dispatched', true).eq('is_cancelled', false).order('dispatched_at', { ascending: true }).range(from, to))
    setRows((data as Row[]) || [])
    setLoading(false)
  }, [supabase])

  useEffect(() => { void loadQueue() }, [loadQueue])

  const isDelivered = (o: Row) => o.tracking_status === 'delivered' || !!o.delivered_at
  const awaiting = useMemo(() => rows.filter(o => !isDelivered(o)), [rows])
  const delivered = useMemo(() => rows.filter(isDelivered), [rows])
  const shown = queueTab === 'awaiting' ? awaiting : queueTab === 'delivered' ? delivered : rows

  const markDelivered = async (o: Row) => {
    setDeliveringId(o.id)
    const now = new Date().toISOString()
    const { error } = await supabase.from('dispatch_orders').update({
      tracking_status: 'delivered', delivered_at: now, manual_delivered_at: now,
      delivery_source: 'manual', delivered_by: currentUserEmail || null, updated_at: now,
    }).eq('id', o.id)
    if (!error) {
      logEvent(o.order_id, 'delivered', `Private delivery confirmed${currentUserEmail ? ` · ${currentUserEmail}` : ''}`)
      setRows(prev => prev.map(r => r.id === o.id ? { ...r, tracking_status: 'delivered', delivered_at: now, delivered_by: currentUserEmail || null } : r))
    }
    setDeliveringId(null)
  }

  const daysAgo = (iso: string | null) => {
    if (!iso) return null
    const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
    return d
  }
  const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '—'

  const exportCsv = () => {
    const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const header = ['Order', 'Customer', 'City', 'SKU', 'Qty', 'Dispatched', 'Transporter', 'LR', 'Status', 'Delivered', 'Delivered by']
    const lines = [header.join(',')]
    shown.forEach(o => lines.push([
      esc(o.order_id), esc(o.customer_name), esc(o.city || ''), esc(o.barcode_sku || o.sku), esc(o.qty),
      esc(fmtDate(o.dispatched_at)), esc(o.transporter || ''), esc(o.lr_number || ''),
      esc(isDelivered(o) ? 'Delivered' : 'Awaiting'), esc(fmtDate(o.delivered_at)), esc(o.delivered_by || ''),
    ].join(',')))
    const csv = '﻿' + lines.join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    a.download = `private-dispatch-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
  }

  // ── add private orders (single + bulk upload) ──
  const [skuMaps, setSkuMaps] = useState<SkuMap[]>([])
  useEffect(() => { supabase.from('dispatch_sku_map').select('*').then(({ data }) => setSkuMaps((data as SkuMap[]) || [])) }, [supabase])
  const skuLookup = useMemo(() => buildSkuLookup(skuMaps), [skuMaps])
  const masterSet = useMemo(() => { const m = new Map<string, string>(); for (const x of skuMaps) if (x.master_sku) m.set(x.master_sku.trim().toLowerCase(), x.master_sku); return m }, [skuMaps])
  const resolveSku = useCallback((orderId: string, sku: string): string | null => {
    const direct = masterSet.get((sku || '').trim().toLowerCase())
    return direct || resolveBarcodeSku(orderId || 'HT', sku, skuLookup)
  }, [masterSet, skuLookup])

  const blankForm = { order_id: '', customer_name: '', contact_number: '', city: '', pincode: '', ship_address: '' }
  type AddForm = typeof blankForm
  type Item = { sku: string; qty: number; price: string }     // price = selling price per unit
  const blankItem = (): Item => ({ sku: '', qty: 1, price: '' })
  const [addMode, setAddMode] = useState<'single' | 'bulk'>('single')
  const [addOpen, setAddOpen] = useState(false)
  const [form, setForm] = useState<AddForm>({ ...blankForm })
  const setF = (k: keyof AddForm, v: string) => setForm(p => ({ ...p, [k]: v }))
  const [items, setItems] = useState<Item[]>([blankItem()])
  const setItem = (i: number, patch: Partial<Item>) => setItems(p => p.map((x, j) => j === i ? { ...x, ...patch } : x))
  const [bulkText, setBulkText] = useState('')
  const [saving, setSaving] = useState(false)
  const [addMsg, setAddMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const num = (v: string) => { const n = parseFloat((v || '').replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n }
  const itemUnits = items.reduce((a, l) => a + l.qty, 0)
  const itemTotal = items.reduce((a, l) => a + (num(l.price) || 0) * l.qty, 0)
  const itemsUnmapped = items.filter(l => l.sku.trim() && !resolveSku(form.order_id, l.sku)).length
  const itemsNoPrice = items.filter(l => num(l.price) == null).length

  // One row per UNIT (qty 2 → two rows of qty 1): each row is one box to scan at dispatch,
  // and each carries its own selling price for reconciliation.
  const buildUnitRows = (f: AddForm, it: { sku: string; qty: number; price: number | null }) => {
    const barcode = resolveSku(f.order_id, it.sku)
    const row = {
      order_id: f.order_id.trim(), customer_name: f.customer_name.trim(), sku: it.sku.trim(),
      barcode_sku: barcode, sku_mapped: !!barcode, qty: 1,
      contact_number: f.contact_number.trim() || null, city: f.city.trim() || null,
      pincode: f.pincode.trim(), ship_address: f.ship_address.trim() || null,
      unit_price: it.price, taxable_value: it.price,
      courier: 'Private', dispatch_method: 'private', tracking_number: null,
      is_dispatched: false, is_cancelled: false, is_priority: false, is_replacement: false,
      order_date: new Date().toISOString().slice(0, 10),
    }
    return Array.from({ length: Math.max(1, it.qty) }, () => ({ ...row }))
  }

  // Every order row must belong to an import batch (dispatch_sessions) — same as the courier importer.
  const makeSession = async (count: number): Promise<string | null> => {
    const { data: { user } } = await supabase.auth.getUser()
    const label = `Private ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
    const { data, error } = await supabase.from('dispatch_sessions')
      .insert({ created_by: user?.id ?? null, session_date: new Date().toISOString().split('T')[0], label, total_orders: count })
      .select('id').single()
    if (error || !data) { setAddMsg({ ok: false, text: `Couldn't save: ${error?.message || 'could not create the import batch'}` }); return null }
    return (data as { id: string }).id
  }

  const addSingle = async () => {
    setAddMsg(null)
    const oid = form.order_id.trim()
    const missing = [!oid && 'Order ID', !form.customer_name.trim() && 'Name', !form.contact_number.trim() && 'Phone', !form.ship_address.trim() && 'Address'].filter(Boolean)
    if (missing.length) { setAddMsg({ ok: false, text: `Required: ${missing.join(', ')}.` }); return }
    if (items.some(l => !l.sku.trim())) { setAddMsg({ ok: false, text: 'Every item needs a SKU (remove empty rows).' }); return }
    if (itemsNoPrice) { setAddMsg({ ok: false, text: 'Every item needs a selling price.' }); return }
    setSaving(true)
    const { data: dupe } = await supabase.from('dispatch_orders').select('id').eq('order_id', oid).limit(1)
    if (dupe && dupe.length) { setSaving(false); setAddMsg({ ok: false, text: `Order ${oid} already exists in DispatchLens.` }); return }
    const baseRows = items.flatMap(l => buildUnitRows(form, { sku: l.sku, qty: l.qty, price: num(l.price) }))
    const sessionId = await makeSession(baseRows.length)
    if (!sessionId) { setSaving(false); return }
    const { error } = await supabase.from('dispatch_orders').insert(baseRows.map(r => ({ ...r, session_id: sessionId })))
    setSaving(false)
    if (error) { setAddMsg({ ok: false, text: `Couldn't save: ${error.message}` }); return }
    logEvent(oid, 'note', `Private order added (manual) · ${items.length} SKU(s), ${baseRows.length} box(es) · ₹${itemTotal}`)
    setAddMsg({ ok: true, text: `Added ${oid} as Private — ${items.length} SKU(s), ${baseRows.length} box(es) to scan${itemsUnmapped ? ` · ${itemsUnmapped} SKU not mapped, map before dispatch` : ''}.` })
    setForm({ ...blankForm }); setItems([blankItem()]); void loadQueue()
  }

  type BulkRow = { f: AddForm; sku: string; qty: number; price: number | null; status: 'ok' | 'unmapped' | 'bad'; barcode: string | null }
  const bulkRows = useMemo(() => {
    const lines = bulkText.split('\n').map(l => l.trimEnd()).filter(l => l.trim())
    if (!lines.length) return [] as BulkRow[]
    const split = (l: string) => (l.includes('\t') ? l.split('\t') : l.split(',')).map(s => s.trim())
    let start = 0
    if (/order\s*id/i.test(lines[0]) && /sku/i.test(lines[0])) start = 1
    const out: BulkRow[] = []
    for (let i = start; i < lines.length; i++) {
      const c = split(lines[i])
      const f: AddForm = { order_id: c[0] || '', customer_name: c[1] || '', contact_number: c[2] || '', city: c[3] || '', pincode: c[4] || '', ship_address: c.slice(8).join(', ') }
      const sku = c[5] || '', qty = Math.max(1, parseInt(c[6] || '1') || 1), price = num(c[7] || '')
      const barcode = f.order_id && sku ? resolveSku(f.order_id, sku) : null
      const bad = !f.order_id || !f.customer_name || !f.contact_number || !sku || price == null || !f.ship_address
      out.push({ f, sku, qty, price, status: bad ? 'bad' : (barcode ? 'ok' : 'unmapped'), barcode })
    }
    return out
  }, [bulkText, resolveSku])   // eslint-disable-line react-hooks/exhaustive-deps

  const addBulk = async () => {
    setAddMsg(null)
    const valid = bulkRows.filter(r => r.status !== 'bad')
    if (!valid.length) { setAddMsg({ ok: false, text: 'Nothing valid to add — each row needs Order ID, Customer, Phone, SKU, Price and Address.' }); return }
    setSaving(true)
    const ids = valid.map(r => r.f.order_id)
    const { data: existing } = await supabase.from('dispatch_orders').select('order_id').in('order_id', ids)
    const existSet = new Set((existing || []).map((e: { order_id: string }) => e.order_id))
    const toInsert = valid.filter(r => !existSet.has(r.f.order_id))
    if (!toInsert.length) { setSaving(false); setAddMsg({ ok: false, text: 'All these Order IDs already exist — nothing added.' }); return }
    const unitRows = toInsert.flatMap(r => buildUnitRows(r.f, { sku: r.sku, qty: r.qty, price: r.price }))
    const sessionId = await makeSession(unitRows.length)
    if (!sessionId) { setSaving(false); return }
    const { error } = await supabase.from('dispatch_orders').insert(unitRows.map(r => ({ ...r, session_id: sessionId })))
    setSaving(false)
    if (error) { setAddMsg({ ok: false, text: `Couldn't save: ${error.message}` }); return }
    Array.from(new Set(toInsert.map(r => r.f.order_id))).forEach(oid => logEvent(oid, 'note', 'Private order added (bulk)'))
    const skipped = valid.length - toInsert.length
    const unmapped = toInsert.filter(r => !r.barcode).length
    setAddMsg({ ok: true, text: `Added ${toInsert.length} line(s), ${unitRows.length} box(es)${skipped ? `, skipped ${skipped} already in the system` : ''}${unmapped ? `, ${unmapped} with an unmapped SKU` : ''}.` })
    setBulkText(''); void loadQueue()
  }

  const addField = (k: keyof AddForm, label: string, opts: { req?: boolean; mono?: boolean; ph?: string; wide?: boolean } = {}) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, gridColumn: opts.wide ? '1 / -1' : undefined }}>
      <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>{label}{opts.req && <span style={{ color: 'var(--accent)' }}> *</span>}</label>
      <input value={form[k]} onChange={e => setF(k, e.target.value)} placeholder={opts.ph || ''}
        style={{ border: '1px solid var(--border)', borderRadius: 9, padding: '9px 11px', fontSize: 14, color: 'var(--text)', background: '#fff', outline: 'none', fontFamily: opts.mono ? 'var(--font-mono)' : 'var(--font-sans)', width: '100%', boxSizing: 'border-box' }} />
    </div>
  )

  const secStyle = { padding: '14px 16px' }
  const secHead = { fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase' as const, color: 'var(--text3)', marginBottom: 10 }
  const itemInp = { border: '1px solid var(--border)', borderRadius: 9, padding: '9px 11px', fontSize: 14, color: 'var(--text)', background: '#fff', outline: 'none', fontFamily: 'var(--font-mono)', boxSizing: 'border-box' as const }
  const stepBtn = { width: 32, height: '100%', border: 'none', background: 'var(--bg2)', fontSize: 16, fontWeight: 700, color: 'var(--text2)', cursor: 'pointer' }

  const privTag = <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: '#efe7f6', color: '#6b3fa0' }}>● Private</span>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1040 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}><Truck size={20} style={{ color: 'var(--accent)' }} /> Private transport</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>Dispatch orders going by a private vehicle (no courier / no AWB) — the box scan still deducts stock. Dispatched orders wait below for manual delivery confirmation.</p>
      </div>

      {/* ── ADD PRIVATE ORDERS (single + bulk upload) ── */}
      <div style={card}>
        <button onClick={() => { setAddOpen(o => !o); setAddMsg(null) }} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', background: 'none', border: 'none', cursor: 'pointer' }}>
          <span style={{ fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 7 }}><Plus size={16} style={{ color: 'var(--accent)' }} /> Add private orders</span>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{addOpen ? 'Hide' : 'Add offline / walk-in orders'}</span>
        </button>

        {addOpen && (
          <div style={{ padding: '0 16px 16px' }}>
            <p style={{ fontSize: 12, color: 'var(--text3)', margin: '0 0 14px' }}>Added here with your own Order IDs, flagged Private automatically, and dropped into Plan for scheduling. The SKU is checked against your barcode map.</p>
            <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
              {([['single', 'Single order', Package], ['bulk', 'Bulk paste', ClipboardList]] as const).map(([k, lbl, Icon]) => (
                <button key={k} onClick={() => { setAddMode(k); setAddMsg(null) }} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, padding: '8px 14px', borderRadius: 999, cursor: 'pointer', border: addMode === k ? 'none' : '1px solid var(--border)', background: addMode === k ? 'var(--accent)' : '#fff', color: addMode === k ? '#fff' : 'var(--text2)' }}><Icon size={14} /> {lbl}</button>
              ))}
            </div>

            {addMsg && (
              <div style={{ marginBottom: 14, padding: '10px 13px', borderRadius: 8, fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 8, background: addMsg.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', border: `1px solid ${addMsg.ok ? '#bbf7d0' : '#fecaca'}`, color: addMsg.ok ? 'var(--dispatched)' : 'var(--critical)' }}>
                {addMsg.ok ? <CheckCircle size={15} style={{ flexShrink: 0, marginTop: 1 }} /> : <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />}<span>{addMsg.text}</span>
              </div>
            )}

            {addMode === 'single' ? (
              <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <div style={secStyle}>
                  <div style={secHead}>Order</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 14px' }}>
                    {addField('order_id', 'Order ID', { req: true, mono: true, ph: 'e.g. HT-OFF-1043' })}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: 'var(--text2)' }}>Order total ₹ <span style={{ color: 'var(--text3)', fontWeight: 400 }}>adds up from the items</span></label>
                      <div style={{ border: '1px solid var(--border)', borderRadius: 9, padding: '9px 11px', fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', background: 'var(--bg2)' }}>{itemTotal.toLocaleString('en-IN')}</div>
                    </div>
                  </div>
                </div>
                <div style={{ ...secStyle, borderTop: '1px solid var(--border)' }}>
                  <div style={secHead}>Customer</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '10px 14px' }}>
                    {addField('customer_name', 'Name', { req: true, ph: 'Full name' })}
                    {addField('contact_number', 'Phone', { req: true, mono: true })}
                    {addField('city', 'City')}
                    {addField('pincode', 'Pincode', { mono: true })}
                    {addField('ship_address', 'Address', { req: true, wide: true })}
                  </div>
                </div>
                <div style={{ ...secStyle, borderTop: '1px solid var(--border)' }}>
                  <div style={{ ...secHead, display: 'flex', justifyContent: 'space-between' }}><span>Items <span style={{ color: 'var(--accent)' }}>*</span></span><span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600 }}>{items.length} SKU{items.length > 1 ? 's' : ''}</span></div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {items.map((l, i) => {
                      const bc = l.sku.trim() ? resolveSku(form.order_id, l.sku) : null
                      const noPrice = num(l.price) == null
                      return (
                        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 10, padding: 8 }}>
                          <span style={{ width: 18, textAlign: 'center', fontSize: 12, fontWeight: 800, color: 'var(--text3)' }}>{i + 1}</span>
                          <input value={l.sku} placeholder="SKU" onChange={e => setItem(i, { sku: e.target.value })} style={{ ...itemInp, flex: '2 1 150px', minWidth: 0 }} />
                          <span title={bc || ''} style={{ flex: '1 1 130px', minWidth: 0, fontSize: 11.5, fontWeight: 700, padding: '5px 9px', borderRadius: 8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontFamily: bc ? 'var(--font-mono)' : 'var(--font-sans)', background: !l.sku.trim() ? 'transparent' : bc ? 'var(--dispatched-bg)' : 'var(--critical-bg)', color: !l.sku.trim() ? 'var(--text3)' : bc ? 'var(--dispatched)' : 'var(--critical)' }}>{!l.sku.trim() ? 'box barcode' : bc ? `✓ ${bc}` : '✕ not mapped'}</span>
                          <input value={l.price} placeholder="Price ₹" inputMode="decimal" onChange={e => setItem(i, { price: e.target.value })} style={{ ...itemInp, flex: '0 1 120px', minWidth: 90, textAlign: 'right', borderColor: noPrice && l.sku.trim() ? 'var(--critical)' : 'var(--border)' }} />
                          <div style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden', height: 38, flexShrink: 0 }}>
                            <button onClick={() => setItem(i, { qty: Math.max(1, l.qty - 1) })} style={stepBtn}>−</button>
                            <span style={{ width: 34, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{l.qty}</span>
                            <button onClick={() => setItem(i, { qty: l.qty + 1 })} style={stepBtn}>+</button>
                          </div>
                          {items.length > 1 && <button onClick={() => setItems(p => p.filter((_, j) => j !== i))} title="Remove this SKU" style={{ border: '1px solid var(--border)', background: '#fff', color: 'var(--text3)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><X size={14} /></button>}
                        </div>
                      )
                    })}
                  </div>
                  <button onClick={() => setItems(p => [...p, blankItem()])} style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px dashed var(--border)', background: '#fff', color: 'var(--text2)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}><Plus size={14} /> Add SKU</button>
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>Price is the selling price per unit. Type a platform SKU or the master SKU; a red chip means it isn&apos;t mapped to a box barcode yet.</div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '14px 16px', borderTop: '1px solid var(--border)', background: 'var(--bg2)' }}>
                  <div style={{ fontSize: 13, color: 'var(--text2)' }}>
                    <b style={{ color: 'var(--text)' }}>{items.length}</b> SKU{items.length > 1 ? 's' : ''} · <b style={{ color: 'var(--text)' }}>{itemUnits}</b> box{itemUnits > 1 ? 'es' : ''} to scan at dispatch
                    {itemsUnmapped ? <span style={{ color: 'var(--critical)' }}> · <b>{itemsUnmapped}</b> not mapped</span> : null}
                    {itemsNoPrice ? <span style={{ color: 'var(--critical)' }}> · <b>{itemsNoPrice}</b> missing price</span> : null}
                  </div>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <button onClick={() => { setForm({ ...blankForm }); setItems([blankItem()]); setAddMsg(null) }} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border)', background: '#fff', color: 'var(--text2)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Clear</button>
                    <button onClick={addSingle} disabled={saving} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 800, fontSize: 14, cursor: 'pointer' }}>{saving ? 'Adding…' : 'Add private order'}</button>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--text2)', marginBottom: 6 }}>Paste rows — one order per line, tab or comma separated</label>
                <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={'Order ID, Customer, Phone, City, Pincode, SKU, Qty, Price, Address\nHT-OFF-1043, Rakesh More, 98XXXXXX21, Dombivli, 421201, ME-BL-BL-RF-2, 1, 12499, 12 Shanti Nagar near station'}
                  style={{ width: '100%', minHeight: 120, border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px', fontSize: 12.5, fontFamily: 'var(--font-mono)', color: 'var(--text)', background: '#fff', outline: 'none', boxSizing: 'border-box', lineHeight: 1.6, whiteSpace: 'pre' }} />
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 6 }}>Columns: Order ID, Customer, Phone, City, Pincode, SKU, Qty, Price (per unit), Address. City and Pincode are optional, the rest are required. Repeat the Order ID on a new line for each extra SKU. A header row is auto-detected.</div>

                {bulkRows.length > 0 && (
                  <>
                    <div style={{ overflowX: 'auto', marginTop: 12, border: '1px solid var(--border)', borderRadius: 9 }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 620 }}>
                        <thead style={{ background: 'var(--bg2)' }}><tr>{['Order ID', 'Customer', 'City', 'SKU → box', 'Qty', 'Price', 'Status'].map((h, i) => <th key={i} style={{ padding: '8px 10px', textAlign: 'left', fontSize: 10.5, fontWeight: 800, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.03em', whiteSpace: 'nowrap' }}>{h}</th>)}</tr></thead>
                        <tbody>
                          {bulkRows.map((r, i) => (
                            <tr key={i} style={{ borderTop: '1px solid var(--border)', background: r.status === 'bad' ? '#fdecec' : r.status === 'unmapped' ? '#fff6e8' : 'transparent' }}>
                              <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>{r.f.order_id || '—'}</td>
                              <td style={{ padding: '8px 10px' }}>{r.f.customer_name || '—'}</td>
                              <td style={{ padding: '8px 10px' }}>{r.f.city || '—'}</td>
                              <td style={{ padding: '8px 10px', fontFamily: 'var(--font-mono)' }}>{r.barcode || r.sku || '—'}</td>
                              <td style={{ padding: '8px 10px' }}>{r.qty}</td>
                              <td style={{ padding: '8px 10px' }}>{r.price != null ? `₹${r.price}` : '—'}</td>
                              <td style={{ padding: '8px 10px' }}><span style={{ fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 999, background: r.status === 'ok' ? 'var(--dispatched-bg)' : r.status === 'unmapped' ? 'var(--amber-bg, #fff4e0)' : 'var(--critical-bg)', color: r.status === 'ok' ? 'var(--dispatched)' : r.status === 'unmapped' ? '#b26a00' : 'var(--critical)' }}>{r.status === 'ok' ? 'OK' : r.status === 'unmapped' ? 'SKU not mapped' : 'Missing req.'}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, fontSize: 12.5, color: 'var(--text2)' }}>
                      <span><b style={{ color: 'var(--text)' }}>{bulkRows.filter(r => r.status === 'ok').length}</b> ready</span>
                      <span style={{ color: '#b26a00' }}><b>{bulkRows.filter(r => r.status === 'unmapped').length}</b> unmapped SKU</span>
                      <span style={{ color: 'var(--critical)' }}><b>{bulkRows.filter(r => r.status === 'bad').length}</b> missing required</span>
                    </div>
                  </>
                )}

                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
                  <button onClick={() => { setBulkText(''); setAddMsg(null) }} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid var(--border)', background: '#fff', color: 'var(--text2)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>Clear</button>
                  <button onClick={addBulk} disabled={saving || !bulkRows.some(r => r.status !== 'bad')} style={{ padding: '10px 18px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 800, fontSize: 14, cursor: saving ? 'default' : 'pointer', opacity: bulkRows.some(r => r.status !== 'bad') ? 1 : 0.5 }}>{saving ? 'Adding…' : `Add ${bulkRows.filter(r => r.status !== 'bad').length || ''} line(s)`}</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── DISPATCH SCANNER ── */}
      <div style={{ ...card, padding: 18, maxWidth: 480 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 7 }}><Package size={16} style={{ color: 'var(--accent)' }} /> Dispatch a private order</div>

        {success && (
          <div style={{ padding: '10px 14px', background: 'var(--dispatched-bg)', border: '1px solid #bbf7d0', borderRadius: 8, color: 'var(--dispatched)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <CheckCircle size={15} style={{ flexShrink: 0 }} />
            <span>Dispatched &amp; flagged Private — <span style={{ fontFamily: 'var(--font-mono)' }}>{success.sku}</span>{success.remaining >= 0 ? <> now <b>{success.remaining}</b> in stock.</> : <> (force-dispatched, not in stock).</>}</span>
          </div>
        )}

        {/* Step 1 — order id */}
        <label style={labelStyle}>1 · SCAN ORDER ID</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={orderInput} onChange={e => setOrderInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') lookupOrder(orderInput) }}
            placeholder="Scan or type the Order ID, press Enter…" disabled={!!order} autoFocus
            style={{ ...inputStyle, border: `1px solid ${order ? 'var(--border)' : 'var(--accent)'}`, background: order ? 'var(--bg2)' : 'var(--bg)' }} />
          {(order || err) && (
            <button onClick={resetScan} title="Clear" style={{ flexShrink: 0, padding: '0 16px', borderRadius: 7, border: '1px solid var(--critical)', background: 'var(--critical-bg)', color: 'var(--critical)', fontSize: 13, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}><X size={15} /> New</button>
          )}
        </div>

        {err && (
          <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--critical-bg)', border: '1px solid #fecaca', borderRadius: 7, color: 'var(--critical)', fontSize: 13, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{err}</span>
          </div>
        )}
        {forceId && (
          <button onClick={() => { setErr(null); void scanBox(forceId, true) }} disabled={busy}
            style={{ marginTop: 10, padding: '8px 16px', borderRadius: 7, border: 'none', background: 'var(--today)', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
            Force dispatch (not in stock)
          </button>
        )}

        {/* Step 2 — order card + confirm + transporter */}
        {order && (
          <div style={{ marginTop: 16 }}>
            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{order.customer_name || '—'}{order.city ? <span style={{ color: 'var(--text3)', fontWeight: 400 }}> · {order.city}</span> : null}</span>
                {privTag}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text3)' }}>{order.order_id}</span>
                {pendingRows.length <= 1 && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: order.barcode_sku ? 'var(--accent)' : 'var(--critical)' }}>{order.barcode_sku ? `${order.barcode_sku}-N` : 'NOT MAPPED'}</span>}
              </div>
              {pendingRows.length > 1 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text3)', marginBottom: 4 }}>{pendingRows.length} ITEMS LEFT TO SCAN</div>
                  {pendingRows.map(r => (
                    <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'var(--font-mono)', fontSize: 12.5, fontWeight: 700, color: r.barcode_sku ? 'var(--accent)' : 'var(--critical)', padding: '2px 0' }}>
                      <span>{r.barcode_sku ? `${r.barcode_sku}-N` : `${r.sku} · NOT MAPPED`}</span><span style={{ color: 'var(--text3)', fontWeight: 400 }}>qty {r.qty}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 12, padding: '11px 13px', background: 'var(--today-bg)', border: '1px solid #fed7aa', borderRadius: 10, fontSize: 12.5, color: '#7a4a00' }}>
              <b>No tracking ID → dispatch as Private transport?</b> Confirm only if this is actually going by private vehicle.
            </div>

            <div style={{ marginTop: 12 }}>
              <label style={{ ...labelStyle, textTransform: 'none' as const }}>Transporter / vehicle <span style={{ color: 'var(--text3)', fontWeight: 400 }}>· optional</span></label>
              <input value={transporter} onChange={e => setTransporter(e.target.value)} placeholder="e.g. Sharma Tempo" style={fieldStyle} />
            </div>
            <div style={{ marginTop: 10 }}>
              <label style={{ ...labelStyle, textTransform: 'none' as const }}>LR / docket no. <span style={{ color: 'var(--text3)', fontWeight: 400 }}>· optional, add later</span></label>
              <input value={lr} onChange={e => setLr(e.target.value)} placeholder="Leave blank if not received yet" style={fieldStyle} />
            </div>

            {stage === 'confirm' ? (
              <button onClick={() => setStage('box')} style={{ marginTop: 16, width: '100%', padding: 12, background: 'var(--accent)', color: '#fff', fontWeight: 800, fontSize: 14, borderRadius: 10, border: 'none', cursor: 'pointer' }}>
                Confirm private → scan box
              </button>
            ) : (
              <div style={{ marginTop: 16 }}>
                <label style={labelStyle}>2 · SCAN BOX BARCODE</label>
                <input value={boxInput} onChange={e => setBoxInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') scanBox(boxInput) }}
                  placeholder="Scan the box — deducts stock…" autoFocus disabled={busy} style={inputStyle} />
                <div style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 8 }}>Expecting <b className="mono" style={{ fontFamily: 'var(--font-mono)' }}>{order.barcode_sku || order.sku}</b>. Same gates as courier dispatch: wrong-SKU and not-in-stock both block here.</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── AWAITING DELIVERY QUEUE ── */}
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {([['awaiting', `Awaiting delivery · ${awaiting.length}`], ['delivered', `Delivered · ${delivered.length}`], ['all', `All private · ${rows.length}`]] as const).map(([k, lbl]) => (
              <button key={k} onClick={() => setQueueTab(k)} style={{ fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', border: queueTab === k ? 'none' : '1px solid var(--border)', background: queueTab === k ? 'var(--accent)' : 'var(--surface)', color: queueTab === k ? '#fff' : 'var(--text3)' }}>{lbl}</button>
            ))}
          </div>
          <button onClick={exportCsv} disabled={!shown.length} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', color: shown.length ? 'var(--text2)' : 'var(--text3)', fontSize: 12, fontWeight: 700, cursor: shown.length ? 'pointer' : 'not-allowed', display: 'inline-flex', alignItems: 'center', gap: 5 }}><Download size={13} /> Export</button>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '48px 0' }}><Spinner size="lg" /></div>
        ) : !shown.length ? (
          <EmptyState icon="🚚" message={queueTab === 'awaiting' ? 'Nothing awaiting delivery' : queueTab === 'delivered' ? 'No delivered private orders yet' : 'No private orders yet'} />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 13, minWidth: 720, borderCollapse: 'collapse' }}>
              <thead style={{ background: 'var(--bg2)' }}>
                <tr>
                  {['Order', 'Customer', 'SKU', 'Dispatched', 'Transporter / LR', 'Waiting', ''].map((h, i) => (
                    <th key={i} style={{ padding: '10px 12px', textAlign: i === 6 ? 'right' : 'left', fontSize: 11, fontWeight: 800, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '.03em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map(o => {
                  const dlvd = isDelivered(o)
                  const age = daysAgo(o.dispatched_at)
                  return (
                    <tr key={o.id} style={{ borderTop: '1px solid var(--border)' }}>
                      <td style={{ padding: '10px 12px' }}>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{o.order_id}</div>
                        <div style={{ marginTop: 3 }}>{privTag}</div>
                      </td>
                      <td style={{ padding: '10px 12px' }}>{o.customer_name || '—'}<div style={{ fontSize: 11, color: 'var(--text3)' }}>{o.city || ''}</div></td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)' }}>{o.barcode_sku || o.sku}</td>
                      <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{fmtDate(o.dispatched_at)}</td>
                      <td style={{ padding: '10px 12px' }}>{o.transporter || <span style={{ color: 'var(--text3)' }}>—</span>}{o.lr_number ? <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>LR {o.lr_number}</div> : null}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {dlvd
                          ? <span style={{ fontSize: 12, color: 'var(--dispatched)', fontWeight: 700 }}>✓ {fmtDate(o.delivered_at)}</span>
                          : <span style={{ fontWeight: 800, color: (age ?? 0) >= 5 ? 'var(--critical)' : 'var(--text2)' }}>{age === 0 ? 'today' : `${age}d`}</span>}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        {dlvd
                          ? <span style={{ fontSize: 11, color: 'var(--text3)' }}>{o.delivered_by || ''}</span>
                          : <button onClick={() => markDelivered(o)} disabled={deliveringId === o.id} style={{ border: '1px solid #bfe3cd', background: 'var(--dispatched-bg)', color: 'var(--dispatched)', fontWeight: 800, fontSize: 12, padding: '7px 12px', borderRadius: 9, cursor: 'pointer', whiteSpace: 'nowrap' }}>{deliveringId === o.id ? 'Saving…' : 'Mark delivered'}</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
