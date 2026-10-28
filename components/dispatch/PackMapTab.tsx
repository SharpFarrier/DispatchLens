'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeMatch, type MatchResult } from '@/lib/packMatch'
import { AlertTriangle, Camera, Undo2 } from 'lucide-react'
import BarcodeScanner from './BarcodeScanner'

// Pack & Map (barcoding phase 3). Scan a coated frame (or a legacy picked one),
// then the SW box barcode.
// On a frame-identity match it COMMITS immediately and lists it with an Undo;
// mismatches block and don't commit.
//
//  - SW path (preferred): the scanned code is an SW box barcode (a packed_units
//    row). We verify the frame against that unit's SKU, then link both sides of
//    the leg — pieces.packed_barcode = the SW serial, status coated/picked -> packed,
//    and packed_units.piece_id = the frame id (the frame<->box genealogy).
//  - SKU fallback (changeover): if the scanned code isn't a packed_units box
//    barcode, we treat it as the old non-serial SKU sticker (map to the SKU, no
//    piece_id link) so leftover old-flow boxes still map during the transition.
//
// Undo reverts packed -> coated (the frame returns to the coated pool, ready to pack
// again) and clears the box's piece_id link.

interface Frame {
  id: string; barcode: string; shape: string | null; size: string | null
  colour: string | null; mattress: string | null; status: string
}
interface SkuMeta { sku: string; product: string | null; size: string | null; fcolor: string | null; mattress: string | null }
interface Done { frameId: string; frameBarcode: string; mappedTo: string; swUnitId: string | null; at: number }

const stripSerial = (code: string) => code.replace(/-\d+$/, '')

export default function PackMapTab(_props: { userId: string; userEmail?: string }) {
  const supabase = createClient()
  const [frame, setFrame] = useState<Frame | null>(null)
  const [frameErr, setFrameErr] = useState('')
  const [meta, setMeta] = useState<SkuMeta | null>(null)
  const [boxErr, setBoxErr] = useState('')
  const [match, setMatch] = useState<MatchResult | null>(null)
  const [done, setDone] = useState<Done[]>([])
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')
  const [packed, setPacked] = useState<number | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const frameRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLInputElement>(null)

  const loadCounts = useCallback(async () => {
    const [p, k] = await Promise.all([
      supabase.from('pieces').select('id', { count: 'exact', head: true }).eq('status', 'packed'),
      supabase.from('pieces').select('id', { count: 'exact', head: true }).eq('status', 'picked'),
    ])
    setPacked(p.count ?? 0); setPicked(k.count ?? 0)
  }, [supabase])
  useEffect(() => { loadCounts() }, [loadCounts])

  const clearCurrent = () => { setFrame(null); setFrameErr(''); setMeta(null); setBoxErr(''); setMatch(null); frameRef.current?.focus() }

  const scanFrame = async (raw: string) => {
    const barcode = raw.trim()
    if (!barcode) return
    setFrameErr(''); setFlash('')
    const { data, error } = await supabase.from('pieces')
      .select('id, barcode, shape, size, colour, mattress, status').eq('barcode', barcode).maybeSingle()
    if (error) { setFrameErr('Lookup failed: ' + error.message); return }
    if (!data) { setFrameErr(`${barcode} — no such frame`); return }
    const f = data as Frame
    if (f.status === 'packed') { setFrameErr(`${barcode} is already packed`); return }
    if (!['picked', 'coated'].includes(f.status)) { setFrameErr(`${barcode} is "${f.status}", not ready to pack`); return }
    setFrame(f); setMeta(null); setMatch(null); setBoxErr('')
    boxRef.current?.focus()
  }

  // Resolve the scanned box code to a SKU meta + (for the SW path) the unit to link.
  // Returns { meta, swUnitId } on success, or { error } to show.
  const resolveBox = async (scanned: string): Promise<{ meta: SkuMeta; swUnitId: string | null } | { error: string }> => {
    // 1. SW path — is this a packed_units box barcode?
    const { data: unit } = await supabase.from('packed_units')
      .select('id, sku, status, piece_id').eq('barcode', scanned).maybeSingle()
    if (unit) {
      if (unit.piece_id) return { error: `${scanned} is already mapped to a frame` }
      if (unit.status !== 'packed') return { error: `${scanned} is "${unit.status}", not available to map` }
      const { data: sk } = await supabase.from('packed_skus')
        .select('sku, product, size, fcolor, mattress').eq('sku', unit.sku).maybeSingle()
      if (!sk) return { error: `${scanned} → SKU ${unit.sku} not found in the catalogue` }
      return { meta: sk as SkuMeta, swUnitId: unit.id }
    }
    // 2. SKU fallback — treat it as the old non-serial SKU sticker.
    let { data: sk } = await supabase.from('packed_skus')
      .select('sku, product, size, fcolor, mattress').eq('sku', scanned).maybeSingle()
    if (!sk) {
      const base = stripSerial(scanned)
      if (base !== scanned) {
        const r = await supabase.from('packed_skus').select('sku, product, size, fcolor, mattress').eq('sku', base).maybeSingle()
        sk = r.data
      }
    }
    if (!sk) return { error: `${scanned} — not a known SW box or SKU (scan the SW label)` }
    return { meta: sk as SkuMeta, swUnitId: null }
  }

  const scanBox = async (raw: string) => {
    const scanned = raw.trim()
    if (!scanned) return
    setBoxErr('')
    if (!frame) { setBoxErr('Scan the frame first'); return }

    const resolved = await resolveBox(scanned)
    if ('error' in resolved) { setBoxErr(resolved.error); return }
    const { meta: m, swUnitId } = resolved

    const result = computeMatch(frame, m)
    if (!result.ok) { setMeta(m); setMatch(result); return }   // block; stays until fixed/cleared

    // Match → commit immediately. For the SW path, packed_barcode carries the SW
    // serial and the box is linked back to the frame via piece_id.
    setBusy(true)
    try {
      const mappedTo = swUnitId ? scanned : m.sku
      // Atomic: pack the frame AND link the box in one transaction (RPC), so a dropped
      // connection can't leave a packed frame with an unlinked box.
      const { data: res, error } = await supabase.rpc('map_frame_to_box', { p_frame_id: frame.id, p_box_id: swUnitId, p_mapped_to: mappedTo })
      if (error) {
        if (/box_already_linked/.test(error.message)) { setBoxErr(`${scanned} was just linked to another frame — rescan the box`); return }
        throw error
      }
      const r = (res || {}) as { ok: boolean; error?: string }
      if (!r.ok) { setBoxErr(`${frame.barcode} was no longer pickable (already packed?)`); return }
      setDone(prev => [{ frameId: frame.id, frameBarcode: frame.barcode, mappedTo, swUnitId, at: Date.now() }, ...prev].slice(0, 60))
      setFlash(`Mapped ${frame.barcode} → ${mappedTo}`)
      clearCurrent()
      loadCounts()
    } catch (e) {
      setBoxErr('Map failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const undo = async (item: Done) => {
    setBusy(true); setFlash('')
    try {
      const { error } = await supabase.from('pieces')
        .update({ status: 'coated', packed_barcode: null, packed_at: null })
        .eq('id', item.frameId).eq('status', 'packed')
      if (error) throw error
      if (item.swUnitId) {
        await supabase.from('packed_units').update({ piece_id: null }).eq('id', item.swUnitId)
      }
      setDone(prev => prev.filter(d => d.frameId !== item.frameId))
      setFlash(`Undone — ${item.frameBarcode} back to coated`)
      loadCounts()
    } catch (e) {
      setFlash('Undo failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onKey = (fn: (v: string) => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = e.currentTarget.value; e.currentTarget.value = ''; void fn(v) }
  }

  return (
    <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap' }}>
        <Tile n={packed} label="Frames packed" />
        <Tile n={picked} label="Still picked" warn />
      </div>

      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: cameraOn ? 10 : 0 }}>
          <button onClick={() => setCameraOn(o => !o)} style={{ ...btn, padding: '7px 12px', background: cameraOn ? 'var(--critical-bg)' : 'var(--surface2)', color: cameraOn ? 'var(--red)' : 'var(--text2)', border: '1px solid var(--border)' }}>
            <Camera size={14} /> {cameraOn ? 'Stop camera' : 'Use camera'}
          </button>
        </div>
        {cameraOn && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 6 }}>
              Camera — now scanning: <b style={{ color: 'var(--accent)' }}>{frame ? 'SW box barcode' : 'frame barcode'}</b>
            </div>
            <BarcodeScanner onScan={(v) => { if (!frame) void scanFrame(v); else void scanBox(v) }} onClose={() => setCameraOn(false)} />
          </div>
        )}

        <Label n={1} text="Scan frame barcode (coated piece)" />
        <input ref={frameRef} autoFocus onKeyDown={onKey(scanFrame)} placeholder="Scan or type frame barcode" style={input} />
        {frameErr && <Msg>{frameErr}</Msg>}
        {frame && (
          <div style={resolved}>
            <Row k="Frame identity" v={[frame.shape, frame.size, frame.colour].filter(Boolean).join(' · ') || '—'} />
            <Row k="Status" v={frame.status} />
          </div>
        )}

        <div style={{ marginTop: 16 }}><Label n={2} text="Scan the SW box barcode — maps on match" /></div>
        <input ref={boxRef} onKeyDown={onKey(scanBox)} placeholder="Scan or type the SW box barcode" style={input} />
        {boxErr && <Msg>{boxErr}</Msg>}
        {match && !match.ok && meta && (
          <div style={blockBanner}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div><b>Blocked — not mapped.</b> {match.reasons.join('; ')}. Grab the right box (or frame), then rescan. <button onClick={clearCurrent} style={{ background: 'none', border: 'none', color: 'var(--red)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12.5, padding: 0 }}>clear</button></div>
          </div>
        )}
        {flash && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--green)', background: 'var(--green-soft)', padding: '8px 11px', borderRadius: 8 }}>{flash}</div>}
      </div>

      {done.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text2)', marginBottom: 8 }}>Mapped this session · {done.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {done.map(d => (
              <div key={d.frameId} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{d.frameBarcode}</span>
                <span style={{ color: 'var(--text3)' }}>→</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>{d.mappedTo}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: d.swUnitId ? 'var(--accent)' : 'var(--text3)', background: d.swUnitId ? 'var(--accent-bg)' : 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 5, padding: '1px 5px' }}>{d.swUnitId ? 'SW' : 'SKU'}</span>
                <span style={{ flex: 1 }} />
                <button onClick={() => undo(d)} disabled={busy} title="Undo this mapping" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text2)', borderRadius: 7, padding: '4px 9px', cursor: 'pointer', fontSize: 11.5, fontWeight: 600 }}>
                  <Undo2 size={13} /> Undo
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16 }
const input: React.CSSProperties = { width: '100%', fontFamily: 'var(--font-mono)', fontSize: 14, color: 'var(--text)', background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px', boxSizing: 'border-box' }
const resolved: React.CSSProperties = { marginTop: 9, border: '1px solid var(--border)', borderRadius: 9, padding: '10px 12px', background: 'var(--surface2)' }
const blockBanner: React.CSSProperties = { display: 'flex', gap: 9, alignItems: 'flex-start', background: 'var(--critical-bg)', border: '1px solid #E6B9B9', borderRadius: 9, padding: '11px 13px', fontSize: 12.5, color: '#7A1F1F', marginTop: 8 }
const btn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, borderRadius: 9, padding: '10px 16px', cursor: 'pointer' }

function Tile({ n, label, warn }: { n?: number | null; label: string; warn?: boolean }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 14px', minWidth: 110 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600, color: warn && (n ?? 0) > 0 ? 'var(--amber)' : 'var(--text)' }}>{n ?? '—'}</div>
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
function Msg({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 7, fontSize: 12, color: 'var(--red)', background: 'var(--red-soft)', padding: '7px 10px', borderRadius: 8 }}>{children}</div>
}
