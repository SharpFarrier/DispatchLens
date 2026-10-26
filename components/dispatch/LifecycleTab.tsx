'use client'
import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from './fetchAll'
import DrumDatePicker from './DrumDatePicker'
import { Search, RotateCcw, Ban, History, X, AlertTriangle, Activity } from 'lucide-react'

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

// Unified frame→box lifecycle. One record per frame (pieces) joined to the box it
// was packed into (packed_units, via piece_id), PLUS frameless boxes (tables,
// mattress-only, pre-Pack&Map). The browse list is a cohort by generation date
// (default last 7 days); the search box is GLOBAL (any barcode, any date).
// Admin actions (void / dispatched-in-error) act on the box and are carried over
// from the old box-centric tab.

interface Piece {
  id: string; barcode: string; shape: string | null; size: string | null; colour: string | null
  mattress: string | null; status: string; created_at: string | null; picked_at: string | null
  packed_at: string | null; packed_barcode: string | null; error_at: string | null; error_reason: string | null
}
interface Box {
  id: string; barcode: string; sku: string; status: string; source: string | null; piece_id: string | null
  packed_at: string | null; stocked_at: string | null; dispatched_at: string | null; picked_at: string | null
  returned_at: string | null; rto_at: string | null; error_at: string | null; error_reason: string | null
  voided_at: string | null; void_reason: string | null; prev_status: string | null
  column_code: string | null; picked_courier: string | null; created_at: string | null
}
interface Rec { key: string; frame: Piece | null; box: Box | null }
interface UnitEvent { id: string; from_status: string | null; to_status: string; reason: string | null; created_at: string }

// The six stages Adi tracks (the box's own column-pick is folded into stocked→dispatched).
const STAGES = [
  { key: 'generated',  label: 'Generated',  c: 'var(--text3)',      bg: 'var(--bg2)' },
  { key: 'picked',     label: 'Picked',     c: 'var(--accent)',     bg: 'var(--accent-bg)' },
  { key: 'packed',     label: 'Packed',     c: 'var(--accent)',     bg: 'var(--accent-bg)' },
  { key: 'stocked',    label: 'In Stock',   c: 'var(--dispatched)', bg: 'var(--dispatched-bg)' },
  { key: 'dispatched', label: 'Dispatched', c: 'var(--text2)',      bg: 'var(--bg2)' },
  { key: 'returned',   label: 'Returned',   c: 'var(--today)',      bg: 'var(--today-bg)' },
] as const
type StageKey = typeof STAGES[number]['key']
const SIDE: Record<string, { label: string; c: string; bg: string }> = {
  void:  { label: 'Void',  c: 'var(--text3)',    bg: 'var(--bg2)' },
  error: { label: 'Error', c: 'var(--critical)', bg: 'var(--critical-bg)' },
}

const IST = 'Asia/Kolkata'
const istYmd = (dt: Date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' }).format(dt)
const addDaysYmd = (ymd: string, n: number) => { const d = new Date(ymd + 'T00:00:00+05:30'); d.setDate(d.getDate() + n); return istYmd(d) }
const sinceIso = (ymd: string) => new Date(ymd + 'T00:00:00+05:30').toISOString()
const untilIso = (ymd: string) => new Date(ymd + 'T23:59:59.999+05:30').toISOString()
const fmt = (t: string | null) => t ? new Date(t).toLocaleString('en-IN', { timeZone: IST, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null

// Stage timestamps for a record (frame half + box half).
function stageTimes(r: Rec): Record<StageKey, string | null> {
  const f = r.frame, b = r.box
  return {
    generated:  f?.created_at ?? b?.created_at ?? null,
    picked:     f?.picked_at ?? null,
    packed:     f?.packed_at ?? b?.packed_at ?? null,
    stocked:    b?.stocked_at ?? null,
    dispatched: b?.dispatched_at ?? null,
    returned:   b?.returned_at ?? b?.rto_at ?? null,
  }
}
// Current furthest stage (with side-states taking priority).
function currentStage(r: Rec): string {
  if (r.box?.status === 'void') return 'void'
  if (r.box?.error_at || r.frame?.status === 'error') return 'error'
  const t = stageTimes(r)
  for (let i = STAGES.length - 1; i >= 0; i--) { if (t[STAGES[i].key]) return STAGES[i].key }
  return 'generated'
}
function badgeFor(stage: string) {
  const s = STAGES.find(x => x.key === stage) || SIDE[stage]
  return s || { label: stage, c: 'var(--text3)', bg: 'var(--bg2)' }
}

export default function LifecycleTab({ userId, isOwner = false }: { userId: string; isOwner?: boolean }) {
  const supabase = createClient()
  const today = istYmd()
  const [from, setFrom] = useState(addDaysYmd(today, -6))
  const [to, setTo] = useState(today)
  const [preset, setPreset] = useState<'7d' | '30d' | '90d' | 'custom'>('7d')
  const [records, setRecords] = useState<Rec[]>([])
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [searchRecs, setSearchRecs] = useState<Rec[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [stageFilter, setStageFilter] = useState<string | null>(null)
  const [selected, setSelected] = useState<Rec | null>(null)
  const [events, setEvents] = useState<Record<string, UnitEvent[]>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [voidModal, setVoidModal] = useState<Box | null>(null)
  const [voidReason, setVoidReason] = useState('')
  const [errorModal, setErrorModal] = useState<Box | null>(null)
  const [errorReason, setErrorReason] = useState('')
  const [msg, setMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null)

  const flash = (text: string, type: 'success' | 'error' = 'success') => { setMsg({ text, type }); setTimeout(() => setMsg(null), 3500) }

  // Fetch rows where `col` is in a possibly-large id list, chunked.
  const chunkIn = useCallback(async <T,>(table: string, col: string, ids: string[]): Promise<T[]> => {
    const out: T[] = []
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from(table).select('*').in(col, ids.slice(i, i + 200))
      if (data) out.push(...(data as T[]))
    }
    return out
  }, [supabase])

  // Given some frames + some boxes, fetch the complementary halves and stitch into records.
  const completeAndStitch = useCallback(async (frames: Piece[], boxes: Box[]): Promise<Rec[]> => {
    const frameById = new Map(frames.map(f => [f.id, f]))
    const missFrameIds = [...new Set(boxes.map(b => b.piece_id).filter((x): x is string => !!x).filter(id => !frameById.has(id)))]
    for (const f of await chunkIn<Piece>('pieces', 'id', missFrameIds)) frameById.set(f.id, f)
    const haveByPiece = new Map(boxes.filter(b => b.piece_id).map(b => [b.piece_id as string, b]))
    const missBoxFrameIds = [...frameById.keys()].filter(id => !haveByPiece.has(id))
    const moreBoxes = await chunkIn<Box>('packed_units', 'piece_id', missBoxFrameIds)
    const allBoxes = [...boxes]
    for (const b of moreBoxes) if (!allBoxes.some(x => x.id === b.id)) allBoxes.push(b)
    const boxByPiece = new Map(allBoxes.filter(b => b.piece_id).map(b => [b.piece_id as string, b]))
    const recs: Rec[] = []
    for (const f of frameById.values()) recs.push({ key: 'f-' + f.id, frame: f, box: boxByPiece.get(f.id) || null })
    for (const b of allBoxes) if (!b.piece_id) recs.push({ key: 'b-' + b.id, frame: null, box: b })
    return recs
  }, [chunkIn])

  // Browse cohort: frames generated in the window + frameless boxes created in the window.
  const loadWindow = useCallback(async () => {
    setLoading(true)
    const s = sinceIso(from), u = untilIso(to)
    const [frames, framelessBoxes] = await Promise.all([
      fetchAllRows<Piece>((f, t) => supabase.from('pieces').select('*').gte('created_at', s).lte('created_at', u).order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t)),
      fetchAllRows<Box>((f, t) => supabase.from('packed_units').select('*').is('piece_id', null).gte('created_at', s).lte('created_at', u).order('created_at', { ascending: false }).order('id', { ascending: false }).range(f, t)),
    ])
    const recs = await completeAndStitch(frames, framelessBoxes)
    recs.sort((a, b) => (stageTimes(b).generated || '').localeCompare(stageTimes(a).generated || ''))
    setRecords(recs)
    setLoading(false)
  }, [supabase, from, to, completeAndStitch])

  useEffect(() => { loadWindow() }, [loadWindow])

  // Global search — any barcode (frame or box), ignoring the date window.
  const runSearch = useCallback(async (raw: string) => {
    const q = raw.trim()
    if (!q) { setSearchRecs(null); return }
    setSearching(true)
    const [frames, boxes] = await Promise.all([
      fetchAllRows<Piece>((f, t) => supabase.from('pieces').select('*').ilike('barcode', `%${q}%`).range(f, t)),
      fetchAllRows<Box>((f, t) => supabase.from('packed_units').select('*').or(`barcode.ilike.%${q}%,sku.ilike.%${q}%`).range(f, t)),
    ])
    const recs = await completeAndStitch(frames, boxes)
    recs.sort((a, b) => (stageTimes(b).generated || '').localeCompare(stageTimes(a).generated || ''))
    setSearchRecs(recs.slice(0, 500))
    setSearching(false)
  }, [supabase, completeAndStitch])

  // Debounce the search box.
  useEffect(() => {
    const h = setTimeout(() => { void runSearch(query) }, 300)
    return () => clearTimeout(h)
  }, [query, runSearch])

  const active = searchRecs !== null ? searchRecs : records
  const list = useMemo(() => {
    if (!stageFilter) return active
    return active.filter(r => { const t = stageTimes(r); return stageFilter === 'generated' ? true : !!t[stageFilter as StageKey] })
  }, [active, stageFilter])

  // Funnel "reached" counts over the active set (cumulative, so count == filtered length).
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const st of STAGES) c[st.key] = active.filter(r => st.key === 'generated' ? true : !!stageTimes(r)[st.key]).length
    return c
  }, [active])

  const pickPreset = (p: '7d' | '30d' | '90d') => {
    setPreset(p); const t = istYmd()
    setTo(t); setFrom(addDaysYmd(t, p === '7d' ? -6 : p === '30d' ? -29 : -89))
  }

  async function selectRec(r: Rec) {
    setSelected(r)
    if (r.box && !events[r.box.id]) {
      const { data } = await supabase.from('packed_unit_events').select('id, from_status, to_status, reason, created_at').eq('packed_unit_id', r.box.id).order('created_at')
      setEvents(prev => ({ ...prev, [r.box!.id]: (data as UnitEvent[]) || [] }))
    }
  }

  // Keep a mutated box in sync across records + selection.
  const patchBox = (boxId: string, patch: Partial<Box>) => {
    const apply = (r: Rec): Rec => r.box && r.box.id === boxId ? { ...r, box: { ...r.box, ...patch } } : r
    setRecords(prev => prev.map(apply))
    setSearchRecs(prev => prev ? prev.map(apply) : prev)
    setSelected(prev => prev && prev.box && prev.box.id === boxId ? { ...prev, box: { ...prev.box, ...patch } } : prev)
  }

  async function logEvent(b: Box, fromS: string, toS: string, reason: string | null) {
    await supabase.from('packed_unit_events').insert({ packed_unit_id: b.id, barcode: b.barcode, from_status: fromS, to_status: toS, reason, actor: userId })
  }

  async function doVoid() {
    const b = voidModal
    if (!b) return
    if (b.status === 'dispatched') { flash('Cannot void a dispatched barcode — dispatch is final.', 'error'); return }
    if (!voidReason.trim()) { flash('Give a reason for voiding', 'error'); return }
    setBusy(b.id)
    const now = new Date().toISOString()
    const { error } = await supabase.from('packed_units').update({ status: 'void', prev_status: b.status, voided_at: now, voided_by: userId, void_reason: voidReason.trim() }).eq('id', b.id)
    if (error) { flash('Error: ' + error.message, 'error'); setBusy(null); return }
    await logEvent(b, b.status, 'void', voidReason.trim())
    patchBox(b.id, { status: 'void', prev_status: b.status, voided_at: now, void_reason: voidReason.trim() })
    setEvents(prev => { const c = { ...prev }; delete c[b.id]; return c })
    flash(`${b.barcode} voided — removed from stock`)
    setVoidModal(null); setVoidReason(''); setBusy(null)
  }

  async function unVoid(b: Box) {
    setBusy(b.id)
    const back = b.prev_status || 'stocked'
    const { error } = await supabase.from('packed_units').update({ status: back, voided_at: null, voided_by: null, void_reason: null, prev_status: null }).eq('id', b.id)
    if (error) { flash('Error: ' + error.message, 'error'); setBusy(null); return }
    await logEvent(b, 'void', back, 'un-voided')
    patchBox(b.id, { status: back, void_reason: null, voided_at: null })
    setEvents(prev => { const c = { ...prev }; delete c[b.id]; return c })
    flash(`${b.barcode} restored`)
    setBusy(null)
  }

  async function markDispatchedInError() {
    const b = errorModal
    if (!b) return
    if (!errorReason.trim()) { flash('Give a reason', 'error'); return }
    setBusy(b.id)
    const now = new Date().toISOString()
    const { error } = await supabase.from('packed_units').update({ status: 'dispatched_in_error', prev_status: b.status, void_reason: errorReason.trim(), voided_at: now, voided_by: userId }).eq('id', b.id)
    if (error) { flash('Error: ' + error.message, 'error'); setBusy(null); return }
    await logEvent(b, b.status, 'dispatched_in_error', errorReason.trim())
    // Order-side reversal: the barcode was flagged dispatched in error → send the order back to Plan.
    const { data: linkedOrders } = await supabase.from('dispatch_orders').select('id, order_id').eq('scanned_barcode', b.barcode).eq('is_dispatched', true)
    let reversed = 0
    for (const o of (linkedOrders || [])) {
      const { error: revErr } = await supabase.from('dispatch_orders').update({
        is_dispatched: false, dispatched_at: null, scan_verified: false, scan_verified_at: null, scanned_barcode: null,
        plan_decision: 'undecided', scheduled_date: null, tracking_number: null, lr_number: null, tracking_status: null,
        dispatch_generated_at: null, dispatch_gen_status: null, dispatch_gen_error: null, updated_at: now,
      }).eq('id', o.id)
      if (!revErr) {
        reversed++
        try { await fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ order_id: o.order_id, event_type: 'dispatch_error', title: `Un-dispatched — barcode ${b.barcode} marked dispatched-in-error · ${errorReason.trim()}`, note: null }) }) } catch { /* best-effort */ }
      }
    }
    patchBox(b.id, { status: 'dispatched_in_error' })
    setEvents(prev => { const c = { ...prev }; delete c[b.id]; return c })
    flash(reversed > 0 ? `${b.barcode} marked dispatched-in-error · ${reversed} order${reversed === 1 ? '' : 's'} back to Plan` : `${b.barcode} marked dispatched-in-error`)
    setErrorModal(null); setErrorReason(''); setBusy(null)
  }

  const idChips = (r: Rec) => {
    const f = r.frame
    const parts = f ? [f.shape, f.size, f.colour, f.mattress].filter(Boolean) : (r.box ? [r.box.sku] : [])
    return parts as string[]
  }
  const stepMeta = (r: Rec, key: StageKey): string => {
    if (key === 'packed') return r.box ? `→ ${r.box.barcode}` : ''
    if (key === 'stocked') return r.box?.column_code ? `Col ${r.box.column_code}` : ''
    if (key === 'dispatched') return r.box?.picked_courier || ''
    return ''
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 16 }}>
      {msg && (
        <div style={{ position: 'fixed' as const, bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, padding: '10px 20px', borderRadius: 20, fontSize: 13, fontWeight: 700, boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
          background: msg.type === 'error' ? 'var(--critical-bg)' : 'var(--dispatched-bg)', color: msg.type === 'error' ? 'var(--critical)' : 'var(--dispatched)', border: `1px solid ${msg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>{msg.text}</div>
      )}

      <div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Frame Lifecycle</h2>
        <p style={{ fontSize: 12, color: 'var(--text3)', margin: '4px 0 0' }}>Follow any frame from barcode generated → picked → packed → stocked → dispatched → returned. Browse is a cohort by generation date; search is global.</p>
      </div>

      {/* Date range */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
        {(['7d', '30d', '90d'] as const).map(p => (
          <button key={p} onClick={() => pickPreset(p)} style={chip(preset === p)}>{p === '7d' ? 'Last 7 days' : p === '30d' ? 'Last 30 days' : 'Last 90 days'}</button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text3)', marginLeft: 4 }}>or</span>
        <DrumDatePicker value={from} onChange={v => { setFrom(v); setPreset('custom') }} placeholder="From" />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>→</span>
        <DrumDatePicker value={to} min={from} onChange={v => { setTo(v); setPreset('custom') }} placeholder="To" />
      </div>

      {/* Funnel */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 8 }}>
        {STAGES.map(st => {
          const n = counts[st.key] || 0
          const pct = counts.generated ? Math.round((n / counts.generated) * 100) : 0
          const on = stageFilter === st.key
          return (
            <button key={st.key} onClick={() => setStageFilter(on ? null : st.key)} style={{ ...stageTile, borderColor: on ? 'var(--accent)' : 'var(--border)', boxShadow: on ? '0 0 0 2px var(--accent-bg)' : 'none' }}>
              <div style={{ fontFamily: 'DM Mono', fontSize: 20, fontWeight: 500, color: 'var(--text)' }}>{n}</div>
              <div style={{ fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '.05em', color: 'var(--text3)' }}>{st.label}</div>
              <div style={{ height: 3, borderRadius: 2, marginTop: 7, background: 'var(--border)' }}><div style={{ height: '100%', borderRadius: 2, width: `${pct}%`, background: st.key === 'returned' ? 'var(--today)' : 'var(--accent)' }} /></div>
            </button>
          )
        })}
      </div>

      {/* Search */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px' }}>
        <Search size={15} style={{ color: 'var(--text3)' }} />
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search any frame barcode or SW serial (all dates)…"
          style={{ flex: 1, border: 'none', outline: 'none', background: 'transparent', padding: '11px 0', fontSize: 14, color: 'var(--text)', fontFamily: 'DM Mono' }} />
        {searching && <span style={{ fontSize: 11, color: 'var(--text3)' }}>searching…</span>}
        {query && <button onClick={() => setQuery('')} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text3)', display: 'flex' }}><X size={15} /></button>}
      </div>

      {/* Selected detail */}
      {selected && (() => {
        const r = selected, t = stageTimes(r), stage = currentStage(r), bdg = badgeFor(stage)
        const headCode = r.frame?.barcode || r.box?.barcode || '—'
        return (
          <div style={{ ...card, padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap' as const }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontFamily: 'DM Mono', fontWeight: 600, fontSize: 17, color: 'var(--text)' }}>{headCode}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, marginTop: 6 }}>
                  {idChips(r).map((c, i) => <span key={i} style={{ fontSize: 11.5, color: 'var(--text2)', background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: '2px 8px' }}>{c}</span>)}
                  {!r.frame && r.box && <span style={{ fontSize: 11, color: 'var(--text3)' }}>· frameless box</span>}
                </div>
              </div>
              <div style={{ textAlign: 'right' as const }}>
                <div style={{ fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '.05em', color: 'var(--text3)' }}>Packed into box</div>
                <div style={{ fontFamily: 'DM Mono', fontWeight: 600, fontSize: 15, color: 'var(--accent)' }}>{r.box?.barcode || '— not yet packed'}</div>
                <div style={{ marginTop: 6 }}><StatusBadge stage={stage} /></div>
              </div>
            </div>

            {/* Stepper */}
            <div style={{ display: 'flex', marginTop: 18, overflowX: 'auto' as const, paddingBottom: 4 }}>
              {STAGES.map((st, i) => {
                const at = t[st.key], done = !!at, isRet = st.key === 'returned' && done
                const meta = done ? stepMeta(r, st.key) : ''
                return (
                  <div key={st.key} style={{ flex: 1, minWidth: 128, position: 'relative' as const, padding: '0 4px' }}>
                    {i < STAGES.length - 1 && <div style={{ position: 'absolute' as const, top: 13, left: '50%', width: '100%', height: 2, background: done ? 'var(--accent)' : 'var(--border)', zIndex: 0 }} />}
                    <div style={{ width: 26, height: 26, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 700, position: 'relative' as const, zIndex: 1,
                      background: done ? (isRet ? 'var(--today)' : 'var(--accent)') : 'var(--surface)', border: `2px solid ${done ? (isRet ? 'var(--today)' : 'var(--accent)') : 'var(--border)'}`, color: done ? '#fff' : 'var(--text3)' }}>{done ? '✓' : ''}</div>
                    <div style={{ fontSize: 12, fontWeight: done ? 600 : 500, color: done ? 'var(--text)' : 'var(--text3)', marginTop: 9 }}>{st.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono', marginTop: 2 }}>{fmt(at) || '—'}</div>
                    {meta && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3 }}>{meta}</div>}
                  </div>
                )
              })}
            </div>

            {(r.box?.void_reason || r.box?.error_reason || r.frame?.error_reason) && (
              <div style={{ fontSize: 11, color: 'var(--critical)', marginTop: 10 }}>{r.box?.void_reason ? `Void: ${r.box.void_reason}` : r.box?.error_reason ? `Error: ${r.box.error_reason}` : `Frame error: ${r.frame?.error_reason}`}</div>
            )}

            {/* Event log */}
            {r.box && events[r.box.id] && events[r.box.id].length > 0 && (
              <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: 'var(--text3)', textTransform: 'uppercase' as const, letterSpacing: '.05em', marginBottom: 6 }}><History size={12} /> Box history</div>
                {events[r.box.id].map(ev => (
                  <div key={ev.id} style={{ fontSize: 11, color: 'var(--text2)', display: 'flex', gap: 8 }}>
                    <span style={{ fontFamily: 'DM Mono', color: 'var(--text3)' }}>{fmt(ev.created_at)}</span>
                    <span>{ev.from_status ? `${ev.from_status} → ` : ''}<b>{ev.to_status}</b>{ev.reason ? ` · ${ev.reason}` : ''}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Admin actions (box-level) */}
            {r.box && (
              <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap' as const, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                {r.box.status === 'void' ? (
                  <button disabled={busy === r.box.id} onClick={() => unVoid(r.box!)} style={actionBtn('var(--accent)')}><RotateCcw size={12} /> Un-void</button>
                ) : r.box.status === 'dispatched' ? (
                  isOwner && <button disabled={busy === r.box.id} onClick={() => setErrorModal(r.box)} style={actionBtn('var(--today)')}><AlertTriangle size={12} /> Dispatched in error</button>
                ) : (r.box.status === 'dispatched_in_error' || r.box.status === 'order_deleted' || r.box.status === 'returned_closed') ? (
                  <span style={{ fontSize: 11, color: 'var(--text3)' }}>closed</span>
                ) : (
                  <button disabled={busy === r.box.id} onClick={() => { setVoidModal(r.box); setVoidReason('') }} style={actionBtn('var(--critical)')}><Ban size={12} /> Void box</button>
                )}
              </div>
            )}
          </div>
        )
      })()}

      {/* List */}
      {loading ? (
        <div style={{ ...card, padding: 48, textAlign: 'center' as const, color: 'var(--text3)' }}>Loading…</div>
      ) : (
        <div style={{ ...card, overflow: 'hidden' }}>
          <div style={{ fontSize: 11, color: 'var(--text3)', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            {searchRecs !== null ? `Search · ${list.length} match${list.length === 1 ? '' : 'es'}` : `Showing ${list.length}${list.length === 500 ? '+' : ''} frame${list.length === 1 ? '' : 's'}`}{stageFilter ? ` · reached ${badgeFor(stageFilter).label}` : ''}
          </div>
          <div style={{ maxHeight: 560, overflowY: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <tbody>
                {list.map(r => {
                  const stage = currentStage(r)
                  return (
                    <Fragment key={r.key}>
                      <tr onClick={() => selectRec(r)} style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', background: selected?.key === r.key ? 'var(--bg2)' : undefined }}>
                        <td style={{ padding: '9px 12px' }}>
                          <div style={{ fontFamily: 'DM Mono', fontWeight: 700, color: 'var(--text)' }}>{r.frame?.barcode || r.box?.barcode}</div>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.frame ? [r.frame.shape, r.frame.size, r.frame.colour, r.frame.mattress].filter(Boolean).join(' · ') : (r.box?.sku || '')}{!r.frame && r.box ? ' · frameless box' : ''}</div>
                        </td>
                        <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' as const }}><span style={{ fontFamily: 'DM Mono', fontSize: 12, color: 'var(--text2)' }}>{r.frame && r.box ? r.box.barcode : '—'}</span></td>
                        <td style={{ padding: '9px 12px', textAlign: 'right' as const, width: 1 }}><StatusBadge stage={stage} /></td>
                      </tr>
                    </Fragment>
                  )
                })}
                {list.length === 0 && <tr><td colSpan={3} style={{ padding: 32, textAlign: 'center' as const, color: 'var(--text3)', fontSize: 13 }}><Activity size={18} style={{ opacity: .4, display: 'block', margin: '0 auto 8px' }} />{searchRecs !== null ? 'No barcode matches.' : 'Nothing in this window.'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Void modal */}
      {voidModal && (
        <div onClick={() => setVoidModal(null)} style={modalWrap}>
          <div onClick={e => e.stopPropagation()} style={{ ...card, padding: 20, maxWidth: 440, width: '100%', display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Void {voidModal.barcode}?</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>Voiding removes this box from inventory permanently — it stops counting as stock and can&apos;t be dispatched. The record is kept with your reason, and an owner can un-void it.</div>
            <input value={voidReason} onChange={e => setVoidReason(e.target.value)} autoFocus placeholder="Reason (required)" style={modalInput} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setVoidModal(null)} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={doVoid} disabled={busy === voidModal.id} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: 'var(--critical)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Void box</button>
            </div>
          </div>
        </div>
      )}

      {/* Dispatched-in-error modal */}
      {errorModal && (
        <div onClick={() => setErrorModal(null)} style={modalWrap}>
          <div onClick={e => e.stopPropagation()} style={{ ...card, padding: 20, maxWidth: 440, width: '100%', display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Mark {errorModal.barcode} dispatched-in-error?</div>
            <div style={{ fontSize: 13, color: 'var(--text2)', lineHeight: 1.5 }}>Use ONLY when a barcode was flagged dispatched but never physically shipped. It closes the box to a distinct terminal state and sends any linked order back to Plan. Dispatch is otherwise final.</div>
            <input value={errorReason} onChange={e => setErrorReason(e.target.value)} autoFocus placeholder="Reason (required)" style={modalInput} />
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => setErrorModal(null)} style={{ padding: '8px 16px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text2)', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
              <button onClick={markDispatchedInError} disabled={busy === errorModal.id} style={{ padding: '8px 16px', borderRadius: 7, border: 'none', background: 'var(--today)', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Mark in error</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function StatusBadge({ stage }: { stage: string }) {
  const m = badgeFor(stage)
  return <span style={{ fontSize: 10, fontFamily: 'DM Mono', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.04em', color: m.c, background: m.bg, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' as const }}>{m.label}</span>
}
function chip(active: boolean) {
  return { padding: '5px 11px', borderRadius: 16, border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`, background: active ? 'var(--accent)' : 'var(--surface)', color: active ? '#fff' : 'var(--text2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const } as const
}
const stageTile: React.CSSProperties = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 11, padding: '11px 12px', cursor: 'pointer', textAlign: 'left' as const }
function actionBtn(color: string) {
  return { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, border: `1px solid ${color}`, background: 'var(--surface)', color, fontSize: 11, fontWeight: 600, cursor: 'pointer' } as const
}
const modalWrap: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
const modalInput: React.CSSProperties = { width: '100%', padding: '10px 12px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)', fontSize: 13, outline: 'none', boxSizing: 'border-box' }
