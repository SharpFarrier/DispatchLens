'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import JsBarcode from 'jsbarcode'
import { Plus, Printer, Trash2, Pencil, ClipboardCheck, X } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

interface ColRow { id: string; bay: number; row: number; column_code: string; sku: string | null; max_qty: number | null; enforce_max: boolean; active: boolean; count?: number }

function BarcodeSvg({ value }: { value: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (ref.current) { try { JsBarcode(ref.current, value, { format: 'CODE128', width: 2, height: 60, fontSize: 14, margin: 8 }) } catch { /* noop */ } }
  }, [value])
  return <svg ref={ref} />
}

export default function ColumnsManageTab({ userEmail, canManage }: { userEmail?: string; canManage: boolean }) {
  const supabase = createClient()
  const [cols, setCols] = useState<ColRow[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<string | null>(null)
  const [printCol, setPrintCol] = useState<ColRow | null>(null)
  const [editCol, setEditCol] = useState<ColRow | null>(null)
  const [auditCol, setAuditCol] = useState<ColRow | null>(null)
  // Add-column form
  const [addOpen, setAddOpen] = useState(false)
  const [newBay, setNewBay] = useState(1)
  const [newRow, setNewRow] = useState(1)
  const [newColNum, setNewColNum] = useState('')
  const [newMax, setNewMax] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const rows = await fetchAllRows<ColRow>((from, to) => supabase.from('stock_columns').select('*').order('bay').order('row').order('column_code').range(from, to))
    // Live counts per column (stocked pieces).
    const counts: Record<string, number> = {}
    const units = await fetchAllRows<{ column_code: string | null }>((from, to) => supabase.from('packed_units').select('column_code').eq('status', 'stocked').not('column_code', 'is', null).range(from, to))
    for (const u of units) { const k = (u.column_code || '').trim(); if (k) counts[k] = (counts[k] || 0) + 1 }
    setCols(rows.map(c => ({ ...c, count: counts[c.column_code] || 0 })))
    setLoading(false)
  }, [supabase])
  useEffect(() => { void load() }, [load])

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 2500) }

  async function addColumn() {
    const cnum = newColNum.trim()
    if (!cnum) { flash('Enter a column number/label'); return }
    const code = `BAY${newBay}-R${newRow}-C${cnum}`
    const { error } = await supabase.from('stock_columns').insert({
      bay: newBay, row: newRow, column_code: code,
      max_qty: newMax.trim() ? parseInt(newMax) : null, created_by: userEmail || null,
    })
    if (error) { flash(error.message.includes('duplicate') ? `${code} already exists` : 'Error: ' + error.message); return }
    flash(`Created ${code}`); setAddOpen(false); setNewColNum(''); setNewMax('')
    await load()
    const created = { id: '', bay: newBay, row: newRow, column_code: code, sku: null, max_qty: newMax.trim() ? parseInt(newMax) : null, enforce_max: false, active: true }
    setPrintCol(created)
  }

  async function saveEdit(c: ColRow, patch: Partial<ColRow>) {
    const { error } = await supabase.from('stock_columns').update(patch).eq('id', c.id)
    if (error) { flash('Error: ' + error.message); return }
    flash('Saved'); setEditCol(null); await load()
  }

  async function removeColumn(c: ColRow) {
    if ((c.count || 0) > 0) { flash(`Empty ${c.column_code} first (${c.count} pieces inside)`); return }
    const { error } = await supabase.from('stock_columns').delete().eq('id', c.id)
    if (error) { flash('Error: ' + error.message); return }
    flash(`Removed ${c.column_code}`); await load()
  }

  // Group by bay -> row
  const bays = Array.from(new Set(cols.map(c => c.bay))).sort((a, b) => a - b)

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16, maxWidth: 620 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>Columns</span>
        {canManage && (
          <button onClick={() => setAddOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
            <Plus size={14} /> Add column
          </button>
        )}
      </div>

      {msg && <div style={{ ...card, padding: '10px 14px', fontSize: 13, color: 'var(--text2)' }}>{msg}</div>}

      {loading ? (
        <div style={{ ...card, padding: 30, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading…</div>
      ) : cols.length === 0 ? (
        <div style={{ ...card, padding: 30, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}>No columns yet.{canManage ? ' Add one to get started.' : ''}</div>
      ) : bays.map(bay => (
        <div key={bay}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>Bay {bay}</div>
          {Array.from(new Set(cols.filter(c => c.bay === bay).map(c => c.row))).sort((a, b) => a - b).map(row => (
            <div key={row} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text3)', marginBottom: 5 }}>Row {row}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
                {cols.filter(c => c.bay === bay && c.row === row).map(c => {
                  const full = c.max_qty != null && (c.count || 0) >= c.max_qty
                  return (
                    <div key={c.column_code} style={{ ...card, padding: 10 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{ fontFamily: 'DM Mono', fontWeight: 700, fontSize: 13 }}>{c.column_code}</span>
                        <span style={{ fontSize: 11, fontFamily: 'DM Mono', color: full ? 'var(--today)' : 'var(--text3)' }}>{c.count || 0}{c.max_qty != null ? `/${c.max_qty}` : ''}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono', margin: '3px 0' }}>{c.sku || '— empty'}</div>
                      <div style={{ height: 4, background: 'var(--bg2)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: c.max_qty ? `${Math.min(100, (c.count || 0) / c.max_qty * 100)}%` : '0%', height: '100%', background: full ? 'var(--today)' : 'var(--accent)' }} />
                      </div>
                      <div style={{ display: 'flex', gap: 4, marginTop: 8, flexWrap: 'wrap' as const }}>
                        <button onClick={() => setPrintCol(c)} title="Print barcode" style={iconBtn}><Printer size={13} /></button>
                        <button onClick={() => setAuditCol(c)} title="Audit count" style={iconBtn}><ClipboardCheck size={13} /></button>
                        {canManage && <button onClick={() => setEditCol(c)} title="Edit" style={iconBtn}><Pencil size={13} /></button>}
                        {canManage && <button onClick={() => removeColumn(c)} title="Remove" style={{ ...iconBtn, color: 'var(--critical)' }}><Trash2 size={13} /></button>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* Add column modal */}
      {addOpen && (
        <Modal onClose={() => setAddOpen(false)} title="Add column">
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <label style={lbl}>Bay<select value={newBay} onChange={e => setNewBay(+e.target.value)} style={inp}>{[1, 2, 3].map(b => <option key={b} value={b}>{b}</option>)}</select></label>
            <label style={lbl}>Row<select value={newRow} onChange={e => setNewRow(+e.target.value)} style={inp}>{[1, 2].map(r => <option key={r} value={r}>{r}</option>)}</select></label>
            <label style={lbl}>Column #<input value={newColNum} onChange={e => setNewColNum(e.target.value)} placeholder="3" style={inp} /></label>
          </div>
          <label style={{ ...lbl, marginBottom: 12 }}>Max qty (optional)<input value={newMax} onChange={e => setNewMax(e.target.value)} placeholder="leave blank for no limit" style={inp} /></label>
          <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12 }}>Will create: <b style={{ fontFamily: 'DM Mono' }}>BAY{newBay}-R{newRow}-C{newColNum || '?'}</b> (SKU locks on first stock-in)</div>
          <button onClick={addColumn} style={primaryBtn}>Create + print barcode</button>
        </Modal>
      )}

      {/* Print barcode modal */}
      {printCol && (
        <Modal onClose={() => setPrintCol(null)} title={`Barcode · ${printCol.column_code}`}>
          <div style={{ textAlign: 'center' as const, background: '#fff', padding: 12, borderRadius: 8 }}>
            <BarcodeSvg value={`COL-${printCol.column_code}`} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--text3)', margin: '10px 0' }}>Print and stick this on the shelf for {printCol.column_code}. Scanning it in Stock-in or Pick sets the active column.</div>
          <button onClick={() => window.print()} style={primaryBtn}><Printer size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Print</button>
        </Modal>
      )}

      {/* Edit modal */}
      {editCol && <EditModal col={editCol} onClose={() => setEditCol(null)} onSave={saveEdit} />}

      {/* Audit modal */}
      {auditCol && <AuditModal col={auditCol} onClose={() => setAuditCol(null)} />}
    </div>
  )
}

const iconBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', cursor: 'pointer' }
const lbl: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: 'var(--text2)', flex: 1 }
const inp: React.CSSProperties = { padding: '8px 10px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 14 }
const primaryBtn: React.CSSProperties = { width: '100%', padding: '10px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' }

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div style={{ position: 'fixed' as const, inset: 0, zIndex: 600, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 'min(400px,94vw)', background: 'var(--surface)', borderRadius: 14, padding: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>{title}</span>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)' }}><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function EditModal({ col, onClose, onSave }: { col: ColRow; onClose: () => void; onSave: (c: ColRow, patch: Partial<ColRow>) => void }) {
  const [sku, setSku] = useState(col.sku || '')
  const [max, setMax] = useState(col.max_qty != null ? String(col.max_qty) : '')
  const [enforce, setEnforce] = useState(col.enforce_max)
  const [active, setActive] = useState(col.active)
  return (
    <Modal title={`Edit ${col.column_code}`} onClose={onClose}>
      <label style={{ ...lbl, marginBottom: 10 }}>SKU (locks the column)<input value={sku} onChange={e => setSku(e.target.value)} placeholder="e.g. L2-B-BL" style={inp} /></label>
      <label style={{ ...lbl, marginBottom: 10 }}>Max qty<input value={max} onChange={e => setMax(e.target.value)} placeholder="blank = no limit" style={inp} /></label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }}><input type="checkbox" checked={enforce} onChange={e => setEnforce(e.target.checked)} /> Hard-block over max (else just warn)</label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 16, cursor: 'pointer' }}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} /> Active</label>
      <button onClick={() => onSave(col, { sku: sku.trim() || null, max_qty: max.trim() ? parseInt(max) : null, enforce_max: enforce, active })} style={primaryBtn}>Save</button>
    </Modal>
  )
}

function AuditModal({ col, onClose }: { col: ColRow; onClose: () => void }) {
  const supabase = createClient()
  const [scanned, setScanned] = useState<string[]>([])
  const [expected, setExpected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    void (async () => {
      const rows = await fetchAllRows<{ barcode: string }>((from, to) => supabase.from('packed_units').select('barcode').eq('column_code', col.column_code).eq('status', 'stocked').range(from, to))
      setExpected(rows.map(r => r.barcode)); setLoading(false)
    })()
  }, [supabase, col.column_code])
  const add = (raw: string) => { const b = raw.trim().replace(/^COL-/i, ''); if (b && !scanned.includes(b)) setScanned(p => [...p, b]) }
  const missing = expected.filter(b => !scanned.includes(b))
  const extra = scanned.filter(b => !expected.includes(b))
  return (
    <Modal title={`Audit ${col.column_code}`} onClose={onClose}>
      <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 10 }}>Scan every piece physically in this column. System expects {loading ? '…' : expected.length}.</div>
      <input ref={inputRef} autoFocus onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value; e.currentTarget.value = ''; add(v) } }} placeholder="Scan pieces in the column" style={{ ...inp, width: '100%', fontFamily: 'DM Mono', textAlign: 'center' as const, marginBottom: 12 }} />
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1, ...card, padding: 10, textAlign: 'center' as const }}><div style={{ fontSize: 20, fontWeight: 700 }}>{scanned.length}</div><div style={{ fontSize: 11, color: 'var(--text3)' }}>scanned</div></div>
        <div style={{ flex: 1, ...card, padding: 10, textAlign: 'center' as const }}><div style={{ fontSize: 20, fontWeight: 700, color: missing.length ? 'var(--critical)' : 'var(--dispatched)' }}>{missing.length}</div><div style={{ fontSize: 11, color: 'var(--text3)' }}>missing</div></div>
        <div style={{ flex: 1, ...card, padding: 10, textAlign: 'center' as const }}><div style={{ fontSize: 20, fontWeight: 700, color: extra.length ? 'var(--today)' : 'var(--text2)' }}>{extra.length}</div><div style={{ fontSize: 11, color: 'var(--text3)' }}>unexpected</div></div>
      </div>
      {missing.length > 0 && <div style={{ fontSize: 11, color: 'var(--critical)', marginBottom: 6 }}>Missing: {missing.slice(0, 8).join(', ')}{missing.length > 8 ? '…' : ''}</div>}
      {extra.length > 0 && <div style={{ fontSize: 11, color: 'var(--today)' }}>Unexpected: {extra.slice(0, 8).join(', ')}{extra.length > 8 ? '…' : ''}</div>}
      {!loading && missing.length === 0 && extra.length === 0 && scanned.length === expected.length && scanned.length > 0 && <div style={{ fontSize: 13, color: 'var(--dispatched)', fontWeight: 700, textAlign: 'center' as const }}>Column matches ✓</div>}
    </Modal>
  )
}
