'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PRODUCT_SHAPE, SIZE_PACKED_TO_SUPPLY } from '@/lib/catalogueMap'
import { computeMatch, type MatchResult } from '@/lib/packMatch'
import { AlertTriangle, Camera, Undo2 } from 'lucide-react'
import BarcodeScanner from './BarcodeScanner'

// Pack & Map (barcoding phase 2). Scan a picked frame, then the NON-SERIAL SKU
// sticker. On a frame-identity match it COMMITS immediately (pieces.packed_barcode
// = SKU, status picked -> packed) and lists it with an Undo; mismatches block and
// don't commit. We map to the SKU, not the serial (serialized format is being
// retired -> SW-001). Undo reverts packed -> picked (picked_at is untouched, so the
// frame returns to the Picking "picked today" log).

interface Frame {
  id: string; barcode: string; shape: string | null; size: string | null
  colour: string | null; mattress: string | null; status: string
}
interface SkuMeta { sku: string; product: string | null; size: string | null; fcolor: string | null; mattress: string | null }
interface Done { frameId: string; frameBarcode: string; sku: string; at: number }

const stripSerial = (code: string) => code.replace(/-\d+$/, '')

export default function PackMapTab(_props: { userId: string; userEmail?: string }) {
  const supabase = createClient()
  const [frame, setFrame] = useState<Frame | null>(null)
  const [frameErr, setFrameErr] = useState('')
  const [meta, setMeta] = useState<SkuMeta | null>(null)
  const [skuErr, setSkuErr] = useState('')
  const [match, setMatch] = useState<MatchResult | null>(null)
  const [done, setDone] = useState<Done[]>([])
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')
  const [packed, setPacked] = useState<number | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const frameRef = useRef<HTMLInputElement>(null)
  const skuRef = useRef<HTMLInputElement>(null)

  const loadCounts = useCallback(async () => {
    const [p, k] = await Promise.all([
      supabase.from('pieces').select('id', { count: 'exact', head: true }).eq('status', 'packed'),
      supabase.from('pieces').select('id', { count: 'exact', head: true }).eq('status', 'picked'),
    ])
    setPacked(p.count ?? 0); setPicked(k.count ?? 0)
  }, [supabase])
  useEffect(() => { loadCounts() }, [loadCounts])

  const clearCurrent = () => { setFrame(null); setFrameErr(''); setMeta(null); setSkuErr(''); setMatch(null); frameRef.current?.focus() }

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
    setFrame(f); setMeta(null); setMatch(null); setSkuErr('')
    skuRef.current?.focus()
  }

  const scanSku = async (raw: string) => {
    const scanned = raw.trim()
    if (!scanned) return
    setSkuErr('')
    if (!frame) { setSkuErr('Scan the frame first'); return }
    let { data } = await supabase.from('packed_skus').select('sku, product, size, fcolor, mattress').eq('sku', scanned).maybeSingle()
    if (!data) {
      const base = stripSerial(scanned)
      if (base !== scanned) {
        const r = await supabase.from('packed_skus').select('sku, product, size, fcolor, mattress').eq('sku', base).maybeSingle()
        data = r.data
      }
    }
    if (!data) { setSkuErr(`${scanned} — not a known SKU (scan the SKU sticker)`); return }
    const m = data as SkuMeta
    const result = computeMatch(frame, m)
    if (!result.ok) { setMeta(m); setMatch(result); return }   // block; stays until fixed/cleared
    // Match → commit immediately.
    setBusy(true)
    try {
      const now = new Date().toISOString()
      const { data: upd, error } = await supabase.from('pieces')
        .update({ status: 'packed', packed_barcode: m.sku, packed_at: now })
        .eq('id', frame.id).in('status', ['picked', 'coated']).select('id')
      if (error) throw error
      if (!upd || !upd.length) { setSkuErr(`${frame.barcode} was no longer pickable (already packed?)`); return }
      setDone(prev => [{ frameId: frame.id, frameBarcode: frame.barcode, sku: m.sku, at: Date.now() }, ...prev].slice(0, 60))
      setFlash(`Mapped ${frame.barcode} → ${m.sku}`)
      clearCurrent()
      loadCounts()
    } catch (e) {
      setSkuErr('Map failed: ' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const undo = async (item: Done) => {
    setBusy(true); setFlash('')
    try {
      const { error } = await supabase.from('pieces')
        .update({ status: 'picked', packed_barcode: null, packed_at: null })
        .eq('id', item.frameId).eq('status', 'packed')
      if (error) throw error
      setDone(prev => prev.filter(d => d.frameId !== item.frameId))
      setFlash(`Undone — ${item.frameBarcode} back to picked`)
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
              Camera — now scanning: <b style={{ color: 'var(--accent)' }}>{frame ? 'SKU sticker' : 'frame barcode'}</b>
            </div>
            <BarcodeScanner onScan={(v) => { if (!frame) void scanFrame(v); else void scanSku(v) }} onClose={() => setCameraOn(false)} />
          </div>
        )}

        <Label n={1} text="Scan frame barcode (picked piece)" />
        <input ref={frameRef} autoFocus onKeyDown={onKey(scanFrame)} placeholder="Scan or type frame barcode" style={input} />
        {frameErr && <Msg>{frameErr}</Msg>}
        {frame && (
          <div style={resolved}>
            <Row k="Frame identity" v={[frame.shape, frame.size, frame.colour].filter(Boolean).join(' · ') || '—'} />
            <Row k="Status" v={frame.status} />
          </div>
        )}

        <div style={{ marginTop: 16 }}><Label n={2} text="Scan the SKU sticker (non-serial) — maps on match" /></div>
        <input ref={skuRef} onKeyDown={onKey(scanSku)} placeholder="Scan or type the SKU barcode" style={input} />
        {skuErr && <Msg>{skuErr}</Msg>}
        {match && !match.ok && meta && (
          <div style={blockBanner}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div><b>Blocked — not mapped.</b> {match.reasons.join('; ')}. Grab the right SKU sticker (or frame), then rescan. <button onClick={clearCurrent} style={{ background: 'none', border: 'none', color: 'var(--red)', textDecoration: 'underline', cursor: 'pointer', fontSize: 12.5, padding: 0 }}>clear</button></div>
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
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>{d.sku}</span>
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
