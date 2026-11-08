'use client'
import { useState, useRef, useCallback, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeMatch } from '@/lib/packMatch'
import { Camera, Undo2, Volume2, VolumeX, Check, X, Lock } from 'lucide-react'
import BarcodeScanner from './BarcodeScanner'

// Pack & Map (barcoding phase 3). Scan a coated frame (or a legacy picked one),
// THEN the SW box barcode — the box step is hard-gated behind a valid frame.
// On a frame-identity match it COMMITS immediately (big green + chime) and lists
// it with an Undo; mismatches block with a big red + buzz and commit nothing.
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
// Transient result layer — the big green/red feedback. null = scanning normally.
type Result = { kind: 'ok'; big: string; detail: string } | { kind: 'err'; big: string; reason: string } | null

const stripSerial = (code: string) => code.replace(/-\d+$/, '')
const SUCCESS_MS = 1300

export default function PackMapTab(_props: { userId: string; userEmail?: string }) {
  const supabase = createClient()
  const [frame, setFrame] = useState<Frame | null>(null)
  const [result, setResult] = useState<Result>(null)
  const [done, setDone] = useState<Done[]>([])
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')              // small status line (undo etc.)
  const [packed, setPacked] = useState<number | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [cameraOn, setCameraOn] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const frameRef = useRef<HTMLInputElement>(null)
  const boxRef = useRef<HTMLInputElement>(null)
  const lockRef = useRef(false)                        // ignore scans during the success window
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- phase is derived, never a redundant source of truth ----
  const phase: 'await_frame' | 'await_box' = frame ? 'await_box' : 'await_frame'

  // ---- sound (Web Audio, no assets) ----
  const acRef = useRef<AudioContext | null>(null)
  const ac = useCallback(() => {
    if (!acRef.current) {
      try { acRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)() } catch { /* no audio */ }
    }
    return acRef.current
  }, [])
  const tone = useCallback((freqs: number[], type: OscillatorType, dur: number, gain: number) => {
    if (!soundOn) return
    const c = ac(); if (!c) return
    if (c.state === 'suspended') void c.resume()
    const t0 = c.currentTime
    freqs.forEach((f, i) => {
      const o = c.createOscillator(), g = c.createGain()
      o.type = type; o.frequency.value = f
      const s = t0 + i * (dur * 0.9)
      g.gain.setValueAtTime(0.0001, s)
      g.gain.exponentialRampToValueAtTime(gain, s + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, s + dur)
      o.connect(g); g.connect(c.destination); o.start(s); o.stop(s + dur + 0.02)
    })
  }, [soundOn, ac])
  const okTone = useCallback(() => tone([660, 990], 'sine', 0.13, 0.25), [tone])
  const errTone = useCallback(() => tone([160, 120], 'square', 0.22, 0.18), [tone])
  const readyTick = useCallback(() => tone([880], 'sine', 0.06, 0.12), [tone])

  useEffect(() => {
    try { const v = localStorage.getItem('packmap_sound'); if (v != null) setSoundOn(v === '1') } catch { /* ignore */ }
  }, [])
  const toggleSound = () => setSoundOn(v => { const n = !v; try { localStorage.setItem('packmap_sound', n ? '1' : '0') } catch { /* ignore */ } return n })

  const loadCounts = useCallback(async () => {
    const [p, k] = await Promise.all([
      supabase.from('pieces').select('id', { count: 'exact', head: true }).eq('status', 'packed'),
      supabase.from('pieces').select('id', { count: 'exact', head: true }).eq('status', 'picked'),
    ])
    setPacked(p.count ?? null); setPicked(k.count ?? null)
  }, [supabase])
  useEffect(() => { loadCounts() }, [loadCounts])
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current) }, [])

  const focusFrame = () => setTimeout(() => frameRef.current?.focus(), 30)
  const focusBox = () => setTimeout(() => boxRef.current?.focus(), 30)

  // Back to a clean "scan a frame" state.
  const toStart = useCallback(() => {
    lockRef.current = false
    setFrame(null); setResult(null)
    if (!cameraOn) focusFrame()
  }, [cameraOn])

  // Dismiss an error, keep the frame if we have one.
  const clearError = () => { setResult(null); if (frame && !cameraOn) focusBox(); else if (!cameraOn) focusFrame() }

  const showError = (big: string, reason: string) => { setResult({ kind: 'err', big, reason }); errTone() }

  const scanFrame = async (raw: string) => {
    if (lockRef.current) return
    const barcode = raw.trim()
    if (!barcode) return
    setResult(null); setFlash('')
    const { data, error } = await supabase.from('pieces')
      .select('id, barcode, shape, size, colour, mattress, status').eq('barcode', barcode).maybeSingle()
    if (error) { showError('LOOKUP FAILED', error.message); return }
    if (!data) { showError('NO SUCH FRAME', `${barcode} — not found`); return }
    const f = data as Frame
    if (f.status === 'packed') { showError('ALREADY PACKED', `${barcode} is already packed`); return }
    if (!['picked', 'coated'].includes(f.status)) { showError('NOT READY', `${barcode} is "${f.status}", not ready to pack`); return }
    setFrame(f); setResult(null); readyTick()
    focusBox()
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
    if (lockRef.current) return
    const scanned = raw.trim()
    if (!scanned) return
    if (!frame) { showError('SCAN FRAME FIRST', 'The box step unlocks after a frame scans'); return }
    setResult(null)

    const resolved = await resolveBox(scanned)
    if ('error' in resolved) { showError('NO MATCH', resolved.error); return }
    const { meta: m, swUnitId } = resolved

    const matchResult = computeMatch(frame, m)
    if (!matchResult.ok) { showError('NO MATCH', matchResult.reasons.join('; ')); return }   // block; nothing commits

    // Match → commit immediately. For the SW path, packed_barcode carries the SW
    // serial and the box is linked back to the frame via piece_id.
    setBusy(true)
    try {
      const mappedTo = swUnitId ? scanned : m.sku
      // Atomic: pack the frame AND link the box in one transaction (RPC), so a dropped
      // connection can't leave a packed frame with an unlinked box.
      const { data: res, error } = await supabase.rpc('map_frame_to_box', { p_frame_id: frame.id, p_box_id: swUnitId, p_mapped_to: mappedTo })
      if (error) {
        if (/box_already_linked/.test(error.message)) { showError('BOX TAKEN', `${scanned} was just linked to another frame — rescan the box`); return }
        throw error
      }
      const r = (res || {}) as { ok: boolean; error?: string }
      if (!r.ok) { showError('NOT PICKABLE', `${frame.barcode} was no longer pickable (already packed?)`); return }
      // success
      const fb = frame.barcode
      setDone(prev => [{ frameId: frame.id, frameBarcode: fb, mappedTo, swUnitId, at: Date.now() }, ...prev].slice(0, 60))
      setResult({ kind: 'ok', big: 'MATCHED', detail: `${fb}  →  ${mappedTo}` })
      okTone()
      lockRef.current = true
      if (resetTimer.current) clearTimeout(resetTimer.current)
      resetTimer.current = setTimeout(toStart, SUCCESS_MS)
      loadCounts()
    } catch (e) {
      showError('MAP FAILED', (e as Error).message)
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

  const frameIdent = frame ? [frame.shape, frame.size, frame.colour].filter(Boolean) : []

  const stripStyle: React.CSSProperties =
    result?.kind === 'ok' ? { background: 'var(--green-soft)', color: 'var(--green)' }
    : result?.kind === 'err' ? { background: 'var(--red-soft)', color: 'var(--red)' }
    : phase === 'await_box' ? { background: 'var(--accent-bg)', color: 'var(--accent)' }
    : { background: 'var(--surface2)', color: 'var(--text2)' }
  const stripText =
    result?.kind === 'ok' ? 'Matched — mapped & committed'
    : result?.kind === 'err' ? 'Blocked — not mapped'
    : phase === 'await_box' ? 'Frame locked — now scan the box'
    : 'Ready — scan a frame to begin'
  const stripDot =
    result?.kind === 'ok' ? 'var(--green)'
    : result?.kind === 'err' ? 'var(--red)'
    : phase === 'await_box' ? 'var(--accent)'
    : 'var(--text3)'

  return (
    <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', gap: 9, flexWrap: 'wrap', alignItems: 'center' }}>
        <Tile n={packed} label="Frames packed" />
        <Tile n={picked} label="Still picked" warn />
        <div style={{ flex: 1 }} />
        <button onClick={toggleSound} title={soundOn ? 'Sound on' : 'Muted'} style={{ ...iconBtn, color: soundOn ? 'var(--accent)' : 'var(--text3)', borderColor: soundOn ? 'var(--accent)' : 'var(--border)', background: soundOn ? 'var(--accent-bg)' : 'var(--surface)' }}>
          {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />} {soundOn ? 'Sound' : 'Muted'}
        </button>
        <button onClick={() => setCameraOn(o => !o)} style={{ ...iconBtn, color: cameraOn ? 'var(--accent)' : 'var(--text2)', borderColor: cameraOn ? 'var(--accent)' : 'var(--border)', background: cameraOn ? 'var(--accent-bg)' : 'var(--surface)' }}>
          <Camera size={14} /> {cameraOn ? 'Camera on' : 'Camera'}
        </button>
      </div>

      <div style={{ ...card, borderColor: phase === 'await_box' && !result ? 'var(--accent)' : 'var(--border)' }}>
        {/* status strip — always reflects the current state in words + colour */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 15px', fontWeight: 700, fontSize: 13.5, ...stripStyle }}>
          <span style={{ width: 10, height: 10, borderRadius: '50%', background: stripDot }} />
          {stripText}
        </div>

        <div style={{ padding: 15 }}>
          {/* success block — big green, auto-resets */}
          {result?.kind === 'ok' && (
            <div style={{ ...resultBlock, background: 'var(--green)' }}>
              <div style={markCircle}><Check size={38} strokeWidth={3} /></div>
              <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: '.02em' }}>{result.big}</div>
              <div style={{ fontSize: 14, fontWeight: 600, fontFamily: 'var(--font-mono)', marginTop: 7, opacity: .96 }}>{result.detail}</div>
              <div style={{ fontSize: 11.5, opacity: .85, marginTop: 11 }}>Returning to the next frame…</div>
            </div>
          )}

          {/* error banner — big red, holds; a rescan or Clear dismisses it */}
          {result?.kind === 'err' && (
            <div style={{ ...resultBlock, background: 'var(--red)', marginBottom: cameraOn || phase === 'await_box' ? 12 : 0 }}>
              <div style={markCircle}><X size={38} strokeWidth={3} /></div>
              <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: '.02em' }}>{result.big}</div>
              <div style={{ display: 'inline-block', fontSize: 13, fontWeight: 600, background: 'rgba(0,0,0,.17)', padding: '7px 13px', borderRadius: 9, marginTop: 11 }}>{result.reason}</div>
              <div style={{ marginTop: 12 }}>
                <button onClick={clearError} style={{ background: 'rgba(255,255,255,.18)', border: '1px solid rgba(255,255,255,.4)', color: '#fff', borderRadius: 8, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                  Clear &amp; rescan
                </button>
              </div>
            </div>
          )}

          {/* camera (shared) — routes to frame or box by phase; stays mounted through success
              (scans are locked out during the window) so the stream never restarts, and stays
              live under an error so a rescan just works */}
          {cameraOn && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 6 }}>
                Camera — scanning: <b style={{ color: 'var(--accent)' }}>{frame ? 'SW box barcode' : 'frame barcode'}</b>
              </div>
              <BarcodeScanner onScan={(v) => { if (!frame) void scanFrame(v); else void scanBox(v) }} onClose={() => setCameraOn(false)} />
            </div>
          )}

          {/* the two gated steps — hidden only during the transient success block */}
          {result?.kind !== 'ok' && (
            <>
              {/* STEP 1 — frame */}
              {!frame ? (
                <div style={{ ...step, ...stepActive }}>
                  <div style={{ ...num, background: 'var(--accent)' }}>1</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={stepCap}>Scan the frame</div>
                    <div style={stepHint}>Coated or picked piece — this unlocks the box step</div>
                    {!cameraOn && <input ref={frameRef} autoFocus onKeyDown={onKey(scanFrame)} placeholder="Scan or type frame barcode" style={{ ...input, borderColor: 'var(--accent)' }} />}
                  </div>
                </div>
              ) : (
                <div style={{ ...step, ...stepDoneFrame }}>
                  <div style={{ ...num, background: 'var(--green)' }}><Check size={13} strokeWidth={3} /></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={stepCap}>Frame</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 13.5 }}>{frame.barcode}</span>
                      <button onClick={toStart} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--accent)', textDecoration: 'underline', cursor: 'pointer', fontSize: 11.5, padding: 0 }}>change</button>
                    </div>
                    <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                      {frameIdent.map((t, i) => <span key={i} style={pill}>{t}</span>)}
                      <span style={pill}>{frame.status}</span>
                    </div>
                  </div>
                </div>
              )}

              {/* STEP 2 — box (gated) */}
              {!frame ? (
                <div style={{ ...step, opacity: .5, marginTop: 11 }}>
                  <div style={num}>2</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={stepCap}>Scan the SW box barcode</div>
                    <div style={{ ...stepHint, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Lock size={11} /> Scan a frame first</div>
                  </div>
                </div>
              ) : (
                <div style={{ ...step, ...(result?.kind === 'err' ? {} : stepActive), marginTop: 11 }}>
                  <div style={{ ...num, background: result?.kind === 'err' ? 'var(--text3)' : 'var(--accent)' }}>2</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={stepCap}>Scan the SW box barcode</div>
                    <div style={stepHint}>Maps automatically on a match</div>
                    {!cameraOn && <input ref={boxRef} onKeyDown={onKey(scanBox)} placeholder="Scan or type the SW box barcode" style={{ ...input, borderColor: 'var(--accent)' }} />}
                  </div>
                </div>
              )}
            </>
          )}

          {flash && <div style={{ marginTop: 12, fontSize: 12.5, color: 'var(--text2)', background: 'var(--surface2)', padding: '8px 11px', borderRadius: 8 }}>{flash}</div>}
        </div>
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

const card: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }
const input: React.CSSProperties = { width: '100%', fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--text)', background: '#fff', border: '1.5px solid var(--border)', borderRadius: 9, padding: '11px 12px', marginTop: 7, boxSizing: 'border-box' }
const iconBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid var(--border)', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600, borderRadius: 9, padding: '7px 11px', cursor: 'pointer' }
const step: React.CSSProperties = { display: 'flex', gap: 11, alignItems: 'flex-start', padding: 12, borderRadius: 11, border: '1px solid var(--border)', background: 'var(--surface2)' }
const stepActive: React.CSSProperties = { background: 'var(--accent-bg)', borderColor: 'var(--accent)', boxShadow: '0 0 0 3px rgba(194,65,12,.10)' }
const stepDoneFrame: React.CSSProperties = { background: 'var(--green-soft)', borderColor: '#bfe6cc' }
const num: React.CSSProperties = { width: 22, height: 22, borderRadius: '50%', flex: 'none', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)', background: 'var(--text3)', color: '#fff' }
const stepCap: React.CSSProperties = { fontSize: 12.5, fontWeight: 700, marginBottom: 3 }
const stepHint: React.CSSProperties = { fontSize: 11.5, color: 'var(--text3)' }
const pill: React.CSSProperties = { fontSize: 10.5, fontWeight: 600, color: 'var(--text2)', background: '#fff', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 7px' }
const resultBlock: React.CSSProperties = { textAlign: 'center', color: '#fff', borderRadius: 12, padding: '24px 16px' }
const markCircle: React.CSSProperties = { width: 62, height: 62, borderRadius: '50%', background: 'rgba(255,255,255,.2)', display: 'grid', placeItems: 'center', margin: '0 auto 10px' }

function Tile({ n, label, warn }: { n?: number | null; label: string; warn?: boolean }) {
  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '9px 14px', minWidth: 110 }}>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 600, color: warn && (n ?? 0) > 0 ? 'var(--amber)' : 'var(--text)' }}>{n ?? '—'}</div>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text3)' }}>{label}</div>
    </div>
  )
}
