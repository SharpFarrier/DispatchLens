'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PRODUCT_SHAPE, SIZE_PACKED_TO_SUPPLY } from '@/lib/catalogueMap'
import { computeMatch, type MatchResult } from '@/lib/packMatch'
import { Link2, Check, AlertTriangle } from 'lucide-react'

// Pack & Map (barcoding phase 2). Scan a picked frame, then the NON-SERIAL SKU
// sticker going on its box. Records which physical frame was packed as which SKU
// (pieces.packed_barcode) and moves it picked -> packed. We map to the SKU, NOT
// the serial, because the current serialized format is being retired (-> SW-001);
// the exact per-serial link is a later phase. Blocks on a frame-identity mismatch
// (shape/size/colour; mattress is decided at packing so it never blocks).

interface Frame {
  id: string; barcode: string; shape: string | null; size: string | null
  colour: string | null; mattress: string | null; status: string
}
interface SkuMeta { sku: string; product: string | null; size: string | null; fcolor: string | null; mattress: string | null }
interface Done { sku: string; frame: string; at: number }

// Scanning the non-serial sticker gives the SKU directly. If someone scans the
// serialized sticker (SKU-seq) instead, strip the trailing -<digits> so either works.
const stripSerial = (code: string) => code.replace(/-\d+$/, '')

export default function PackMapTab(_props: { userId: string; userEmail?: string }) {
  const supabase = createClient()
  const [frame, setFrame] = useState<Frame | null>(null)
  const [frameErr, setFrameErr] = useState('')
  const [meta, setMeta] = useState<SkuMeta | null>(null)
  const [skuErr, setSkuErr] = useState('')
  const [match, setMatch] = useState<MatchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<Done[]>([])
  const [packed, setPacked] = useState<number | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
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

  const resetAll = () => { setFrame(null); setFrameErr(''); setMeta(null); setSkuErr(''); setMatch(null); frameRef.current?.focus() }

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
    if (meta) setMatch(computeMatch(f, meta))
    skuRef.current?.focus()
  }

  const scanSku = async (raw: string) => {
    const scanned = raw.trim()
    if (!scanned) return
    setSkuErr('')
    // Try the scanned value as a SKU; if that's a serialized sticker, strip the serial.
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
    setMeta(m)
    setMatch(frame ? computeMatch(frame, m) : null)
  }

  const confirm = async () => {
    if (!frame || !meta || !match?.ok || busy) return
    setBusy(true)
    try {
      const now = new Date().toISOString()
      const { error } = await supabase.from('pieces')
        .update({ status: 'packed', packed_barcode: meta.sku, packed_at: now })
        .eq('id', frame.id).in('status', ['picked', 'coated'])
      if (error) throw error
      setDone(prev => [{ sku: meta.sku, frame: frame.barcode, at: Date.now() }, ...prev].slice(0, 40))
      resetAll()
      loadCounts()
    } catch (e) {
      setSkuErr('Map failed: ' + (e as Error).message)
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
        <Label n={1} text="Scan frame barcode (picked piece)" />
        <input ref={frameRef} autoFocus onKeyDown={onKey(scanFrame)} placeholder="Scan or type frame barcode" style={input} />
        {frameErr && <Msg>{frameErr}</Msg>}
        {frame && (
          <div style={resolved}>
            <Row k="Frame identity" v={[frame.shape, frame.size, frame.colour].filter(Boolean).join(' · ') || '—'} />
            <Row k="Mattress (planning tag)" v={frame.mattress || '—'} />
            <Row k="Status" v={frame.status} />
          </div>
        )}

        <div style={{ marginTop: 16 }}><Label n={2} text="Scan the SKU sticker (non-serial)" /></div>
        <input ref={skuRef} onKeyDown={onKey(scanSku)} placeholder="Scan or type the SKU barcode" style={input} />
        {skuErr && <Msg>{skuErr}</Msg>}
        {meta && (
          <div style={resolved}>
            <Row k="SKU" v={meta.sku} mono />
            <Row k="SKU frame identity" v={[meta.product ? PRODUCT_SHAPE[meta.product] : null, meta.size ? SIZE_PACKED_TO_SUPPLY[meta.size] : null, meta.fcolor].filter(Boolean).join(' · ') || '—'} />
            {match && (
              <Row k="Check" v={match.ok
                ? <span style={{ ...chip, ...chipOk }}>✓ frame matches SKU</span>
                : <span style={{ ...chip, ...chipBad }}>✗ mismatch</span>} />
            )}
          </div>
        )}

        <div style={{ marginTop: 16 }}><Label n={3} text="Confirm" /></div>
        {match && !match.ok && (
          <div style={blockBanner}>
            <AlertTriangle size={15} style={{ flexShrink: 0, marginTop: 1 }} />
            <div><b>Blocked — not mapped.</b> {match.reasons.join('; ')}. Fix the frame or grab the right SKU sticker, then rescan.</div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 9, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={confirm} disabled={!frame || !meta || !match?.ok || busy}
            style={{ ...btn, background: 'var(--accent)', color: '#fff', opacity: (!frame || !meta || !match?.ok || busy) ? 0.45 : 1, cursor: (!frame || !meta || !match?.ok || busy) ? 'not-allowed' : 'pointer' }}>
            <Link2 size={14} /> {busy ? 'Mapping…' : 'Map & mark Packed'}
          </button>
          <button onClick={resetAll} style={{ ...btn, background: 'var(--surface2)', color: 'var(--text2)', border: '1px solid var(--border)' }}>Clear</button>
          {frame && meta && match?.ok && (
            <span style={{ fontSize: 12, color: 'var(--text3)' }}>
              Frame <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{frame.barcode}</b> → <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{meta.sku}</b>
            </span>
          )}
        </div>
      </div>

      {done.length > 0 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text2)', marginBottom: 8 }}>Mapped this session · {done.length}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {done.map((d, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 9, padding: '8px 12px', fontSize: 12.5 }}>
                <Check size={14} style={{ color: 'var(--green)', flexShrink: 0 }} />
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{d.frame}</span>
                <span style={{ color: 'var(--text3)' }}>→</span>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text2)' }}>{d.sku}</span>
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
const blockBanner: React.CSSProperties = { display: 'flex', gap: 9, alignItems: 'flex-start', background: 'var(--critical-bg)', border: '1px solid #E6B9B9', borderRadius: 9, padding: '11px 13px', fontSize: 12.5, color: '#7A1F1F', marginTop: 4 }
const btn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: 'none', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, borderRadius: 9, padding: '10px 16px' }
const chip: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', fontSize: 11.5, fontWeight: 600, borderRadius: 6, padding: '2px 8px' }
const chipOk: React.CSSProperties = { color: 'var(--green)', background: 'var(--green-soft)' }
const chipBad: React.CSSProperties = { color: 'var(--red)', background: 'var(--red-soft)' }

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
