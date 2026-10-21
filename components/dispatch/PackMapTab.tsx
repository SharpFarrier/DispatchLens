'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PRODUCT_SHAPE, SIZE_PACKED_TO_SUPPLY } from '@/lib/catalogueMap'
import { computeMatch, type MatchResult } from '@/lib/packMatch'
import { Link2, Check, AlertTriangle } from 'lucide-react'

// Pack & Map (barcoding phase 2). Scan a picked frame, then the serialized box
// label going on it. Ties that serial (packed_units.piece_id) to the physical
// frame, blocks on a frame-identity mismatch (shape/size/colour; mattress is
// decided at packing, so it never blocks), and moves the frame picked -> packed.

interface Frame {
  id: string; barcode: string; shape: string | null; size: string | null
  colour: string | null; mattress: string | null; status: string
}
interface Unit { id: string; barcode: string; sku: string; seq: number | null; status: string; piece_id: string | null }
interface SkuMeta { product: string | null; size: string | null; fcolor: string | null; mattress: string | null }
interface Counts { mapped: number; unmapped_frames: number; tables: number }
interface Done { serial: string; frame: string; sku: string; at: number }

export default function PackMapTab(_props: { userId: string; userEmail?: string }) {
  const supabase = createClient()
  const [frame, setFrame] = useState<Frame | null>(null)
  const [frameErr, setFrameErr] = useState('')
  const [unit, setUnit] = useState<Unit | null>(null)
  const [meta, setMeta] = useState<SkuMeta | null>(null)
  const [unitErr, setUnitErr] = useState('')
  const [match, setMatch] = useState<MatchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Done[]>([])
  const [counts, setCounts] = useState<Counts | null>(null)
  const frameRef = useRef<HTMLInputElement>(null)
  const serialRef = useRef<HTMLInputElement>(null)

  const loadCounts = useCallback(async () => {
    const { data } = await supabase.rpc('pm_serial_counts')
    if (data) setCounts(data as Counts)
  }, [supabase])
  useEffect(() => { loadCounts() }, [loadCounts])

  const resetAll = () => { setFrame(null); setFrameErr(''); setUnit(null); setMeta(null); setUnitErr(''); setMatch(null); frameRef.current?.focus() }

  const scanFrame = async (raw: string) => {
    const barcode = raw.trim()
    if (!barcode) return
    setFrameErr('')
    const { data, error } = await supabase.from('pieces')
      .select('id, barcode, shape, size, colour, mattress, status').eq('barcode', barcode).maybeSingle()
    if (error) { setFrameErr('Lookup failed: ' + error.message); return }
    if (!data) { setFrameErr(`${barcode} — no such frame`); return }
    const f = data as Frame
    if (f.status === 'packed') { setFrameErr(`${barcode} is already packed`); return }
    if (!['picked', 'coated'].includes(f.status)) { setFrameErr(`${barcode} is "${f.status}", not ready to pack`); return }
    setFrame(f)
    // Re-check any already-scanned serial against the new frame.
    if (meta) setMatch(computeMatch(f, meta))
    serialRef.current?.focus()
  }

  const scanSerial = async (raw: string) => {
    const barcode = raw.trim()
    if (!barcode) return
    setUnitErr('')
    const { data, error } = await supabase.from('packed_units')
      .select('id, barcode, sku, seq, status, piece_id').eq('barcode', barcode).maybeSingle()
    if (error) { setUnitErr('Lookup failed: ' + error.message); return }
    if (!data) { setUnitErr(`${barcode} — not a known serial (generate it first)`); return }
    const u = data as Unit
    if (['dispatched', 'returned', 'void', 'error'].includes(u.status)) { setUnitErr(`${barcode} is "${u.status}" — can't map`); return }
    if (u.piece_id) { setUnitErr(`${barcode} is already mapped to a frame`); return }
    const { data: ms } = await supabase.from('packed_skus').select('product, size, fcolor, mattress').eq('sku', u.sku).maybeSingle()
    if (!ms) { setUnitErr(`SKU ${u.sku} not in the catalogue — can't verify`); return }
    const m = ms as SkuMeta
    setUnit(u); setMeta(m)
    setMatch(frame ? computeMatch(frame, m) : null)
  }

  const confirm = async () => {
    if (!frame || !unit || !match?.ok || busy) return
    setBusy(true)
    try {
      const now = new Date().toISOString()
      const { error: uErr } = await supabase.from('packed_units')
        .update({ piece_id: frame.id, packed_at: now }).eq('id', unit.id).is('piece_id', null)
      if (uErr) throw uErr
      const { error: pErr } = await supabase.from('pieces')
        .update({ status: 'packed', packed_barcode: unit.barcode, packed_at: now })
        .eq('id', frame.id).in('status', ['picked', 'coated'])
      if (pErr) throw pErr
      setDone(prev => [{ serial: unit.barcode, frame: frame.barcode, sku: unit.sku, at: Date.now() }, ...prev].slice(0, 40))
      resetAll()
      loadCounts()
    } catch (e) {
      setUnitErr('Map failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onKey = (fn: (v: string) => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value; e.currentTarget.value = ''; void fn(v) }
  }

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* count tiles */}
      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
        <Tile n={counts?.mapped} label="Serials mapped" />
        <Tile n={counts?.unmapped_frames} label="Unmapped frames" warn />
        <Tile n={counts?.tables} label="Tables · no frame" />
      </div>

      <div style={card}>
        {/* step 1 */}
        <Label n={1} text="Scan frame barcode (picked piece)" />
        <input ref={frameRef} autoFocus onKeyDown={onKey(scanFrame)} placeholder="Scan or type frame barcode" style={input} />
        {frameErr && <Msg tone="err">{frameErr}</Msg>}
        {frame && (
          <div style={resolved}>
            <Row k="Frame identity" v={[frame.shape, frame.size, frame.colour].filter(Boolean).join(' · ') || '—'} />
            <Row k="Mattress (planning tag)" v={frame.mattress || '—'} />
            <Row k="Status" v={frame.status} />
          </div>
        )}

        {/* step 2 */}
        <div style={{ marginTop: 16 }}><Label n={2} text="Scan the serialized box label" /></div>
        <input ref={serialRef} onKeyDown={onKey(scanSerial)} placeholder="Scan or type serialized barcode" style={input} />
        {unitErr && <Msg tone="err">{unitErr}</Msg>}
        {unit && meta && (
          <div style={resolved}>
            <Row k="Serial" v={unit.seq != null ? String(unit.seq) : unit.barcode} mono />
            <Row k="SKU" v={unit.sku} mono />
            <Row k="SKU frame identity" v={[meta.product ? PRODUCT_SHAPE[meta.product] : null, meta.size ? SIZE_PACKED_TO_SUPPLY[meta.size] : null, meta.fcolor].filter(Boolean).join(' · ') || '—'} />
            {match && (
              <Row k="Check" v={match.ok
                ? <span style={{ ...chip, ...chipOk }}>✓ frame matches SKU</span>
                : <span style={{ ...chip, ...chipBad }}>✗ mismatch</span>} />
            )}
          </div>
        )}

        {/* step 3 */}
        <div style={{ marginTop: 16 }}><Label n={3} text="Confirm" /></div>
        {match && !match.ok && (
          <div style={blockBanner}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div><b>Blocked — not mapped.</b> {match.reasons.join('; ')}. Fix the frame or grab the right label, then rescan.</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 9, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={confirm} disabled={!frame || !unit || !match?.ok || busy}
            style={{ ...btn, background: 'var(--accent)', color: '#fff', opacity: (!frame || !unit || !match?.ok || busy) ? 0.45 : 1, cursor: (!frame || !unit || !match?.ok || busy) ? 'not-allowed' : 'pointer' }}>
            <Link2 size={14} /> {busy ? 'Mapping…' : 'Map & mark Packed'}
          </button>
          <button onClick={resetAll} style={{ ...btn, background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>Clear</button>
          {frame && unit && match?.ok && (
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>
              Serial <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{unit.seq ?? unit.barcode}</b> → frame <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{frame.barcode}</b>
            </span>
          )}
        </div>
      </div>

      {/* session list */}
      {done.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text2)', marginBottom: 8 }}>Mapped this session · {done.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {done.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5 }}>
                <Check size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{d.serial}</span>
                <span style={{ color: 'var(--text3)' }}>→</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>{d.frame}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text3)', fontSize: 11 }}>{d.sku}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── small presentational helpers ──
const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }
const input: React.CSSProperties = { width: '100%', fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px', boxSizing: 'border-box' }
const resolved: React.CSSProperties = { marginTop: 9, border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px', background: 'var(--surface2)' }
const blockBanner: React.CSSProperties = { display: 'flex', gap: 9, alignItems: 'flex-start', background: 'var(--critical-bg)', border: '1px solid #E6B9B9', borderRadius: 9, padding: '11px 13px', fontSize: 12.5, color: '#7A1F1F', marginTop: 4 }
const btn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, borderRadius: 9, padding: '10px 16px' }
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, borderRadius: 6, padding: '2px 8px' }
const chipOk: React.CSSProperties = { color: 'var(--green)', background: 'var(--green-soft)' }
const chipBad: React.CSSProperties = { color: 'var(--red)', background: 'var(--red-soft)' }

function Tile({ n, label, warn }: { n?: number; label: string; warn?: boolean }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 14px', minWidth: 104 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600, color: warn && (n ?? 0) > 0 ? 'var(--red)' : 'var(--text)' }}>{n ?? '—'}</div>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text3)' }}>{label}</div>
    </div>
  )
}
function Label({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 7 }}>
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{n}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{text}</span>
    </div>
  )
}
function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0', fontSize: 12.5 }}>
      <span style={{ color: 'var(--text3)' }}>{k}</span>
      <span style={{ fontWeight: 600, color: 'var(--text)', fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)' }}>{v}</span>
    </div>
  )
}
function Msg({ tone, children }: { tone: 'err'; children: React.ReactNode }) {
  return <div style={{ marginTop: 7, fontSize: 12, color: 'var(--red)', background: 'var(--red-soft)', padding: '7px 10px', borderRadius: 8 }}>{children}</div>
}
