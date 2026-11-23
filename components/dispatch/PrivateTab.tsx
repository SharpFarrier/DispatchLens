'use client'
import { useState, useMemo, useEffect, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import { Spinner, EmptyState } from './warehouse-ui'
import { beepSuccess, beepError, beepWarn } from './scanFeedback'
import { Truck, Package, AlertTriangle, CheckCircle, Download, X } from 'lucide-react'

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
  const [stage, setStage] = useState<'scan' | 'confirm' | 'box'>('scan')
  const [transporter, setTransporter] = useState('')
  const [lr, setLr] = useState('')
  const [boxInput, setBoxInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [forceId, setForceId] = useState<string | null>(null)  // box barcode awaiting force-dispatch
  const [success, setSuccess] = useState<{ sku: string; remaining: number } | null>(null)

  const resetScan = () => {
    setOrderInput(''); setOrder(null); setStage('scan'); setTransporter(''); setLr('')
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
    if (rows.some(o => o.is_dispatched && !o.is_cancelled)) { beepError(); setErr(`${oid} is already dispatched — not dispatching again.`); return }
    if (rows.length && rows.every(o => o.is_cancelled)) { beepError(); setErr(`${oid} is cancelled — un-cancel it in Plan first if this is wrong.`); return }
    const held = rows.find(o => isHeld(o))
    if (held) { beepError(); setErr(`${oid} is On Hold — release it in the Plan tab before dispatching.`); return }
    const o = rows.find(x => !x.is_cancelled && !x.is_dispatched)
    if (!o) { beepError(); setErr(`No pending order to dispatch for ${oid}.`); return }
    if ((o.tracking_number || '').trim()) {
      beepWarn()
      setErr(`${oid} has a tracking ID (${o.tracking_number}) — dispatch it from the courier scanner, not the private lane.`)
      return
    }
    beepSuccess()
    setOrder(o); setTransporter(o.transporter || ''); setLr(o.lr_number || ''); setStage('confirm')
  }

  const scanBox = async (rawBarcode: string, force = false) => {
    const barcode = rawBarcode.trim()
    if (!barcode || !order) return
    setErr(null); setBusy(true)
    let deductedSku: string | null = null

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
      if (order.barcode_sku && u.sku && u.sku !== order.barcode_sku) {
        setBusy(false); beepError()
        setErr(`WRONG ITEM — expected ${order.barcode_sku}, scanned ${u.sku}. Not dispatched.`)
        return
      }
      await supabase.from('packed_units').update({ status: 'dispatched', dispatched_at: new Date().toISOString() }).eq('id', u.id).in('status', ['stocked', 'picked'])
      deductedSku = u.sku
    }

    const now = new Date().toISOString()
    const { data: updated, error } = await supabase.from('dispatch_orders').update({
      is_dispatched: true, dispatched_at: now, scan_verified: true, scan_verified_at: now,
      scanned_barcode: barcode, dispatch_method: 'private',
      transporter: transporter.trim() || null, lr_number: lr.trim() || null, updated_at: now,
    }).eq('id', order.id).eq('is_dispatched', false).select(SELECT)
    setBusy(false)

    if (error || !updated || !updated.length) {
      beepError(); setErr('That order was already dispatched — not counting it again.'); return
    }
    if (deductedSku) {
      const { count } = await supabase.from('packed_units').select('id', { count: 'exact', head: true }).eq('sku', deductedSku).eq('status', 'stocked')
      setSuccess({ sku: deductedSku, remaining: count ?? 0 })
    } else {
      setSuccess({ sku: order.barcode_sku || order.sku || '—', remaining: -1 })
    }
    beepSuccess()
    logEvent(order.order_id, 'dispatched', `Private dispatch · box ${barcode}${force ? ' (FORCE — not in stock)' : ''}${transporter.trim() ? ` · ${transporter.trim()}` : ''}`)
    resetScan()
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

  const privTag = <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 800, padding: '2px 8px', borderRadius: 999, background: '#efe7f6', color: '#6b3fa0' }}>● Private</span>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 1040 }}>
      <div>
        <h2 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 4px', display: 'flex', alignItems: 'center', gap: 8 }}><Truck size={20} style={{ color: 'var(--accent)' }} /> Private transport</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', margin: 0 }}>Dispatch orders going by a private vehicle (no courier / no AWB) — the box scan still deducts stock. Dispatched orders wait below for manual delivery confirmation.</p>
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
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: order.barcode_sku ? 'var(--accent)' : 'var(--critical)' }}>{order.barcode_sku ? `${order.barcode_sku}-N` : 'NOT MAPPED'}</span>
              </div>
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
