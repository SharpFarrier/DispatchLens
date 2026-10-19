'use client'
import { useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { ReqPriority } from '@/lib/requests'
import { Plus, X, ImagePlus } from 'lucide-react'

// Floating "+ Request" button present on every tab. It auto-captures the tab the
// person is on, takes a short note, optional details, a priority, and up to 6
// screenshots (uploaded to a private bucket), then POSTs to /api/requests.

const MAX_SHOTS = 6
const BUCKET = 'request-screenshots'

type Shot = { file: File; preview: string }

export default function RequestButton({
  tabKey, tabLabel, userEmail, isMobile, onSubmitted,
}: {
  tabKey: string; tabLabel: string; userEmail: string; isMobile?: boolean; onSubmitted?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [priority, setPriority] = useState<ReqPriority>('med')
  const [shots, setShots] = useState<Shot[]>([])
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    shots.forEach(s => URL.revokeObjectURL(s.preview))
    setTitle(''); setDetails(''); setPriority('med'); setShots([]); setErr(''); setDone(false)
  }
  const close = () => { if (busy) return; setOpen(false); reset() }

  const addFiles = (list: FileList | null) => {
    if (!list) return
    const next: Shot[] = []
    for (const f of Array.from(list)) {
      if (!f.type.startsWith('image/')) continue
      next.push({ file: f, preview: URL.createObjectURL(f) })
    }
    setShots(prev => [...prev, ...next].slice(0, MAX_SHOTS))
    if (fileRef.current) fileRef.current.value = ''
  }
  const removeShot = (i: number) => {
    setShots(prev => { URL.revokeObjectURL(prev[i].preview); return prev.filter((_, j) => j !== i) })
  }

  const submit = async () => {
    if (!title.trim() || busy) return
    setBusy(true); setErr('')
    try {
      const supabase = createClient()
      const safeEmail = userEmail.replace(/[^a-zA-Z0-9]/g, '_')
      const paths: string[] = []
      for (let i = 0; i < shots.length; i++) {
        const f = shots[i].file
        const ext = (f.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')
        const path = `${safeEmail}/${Date.now()}-${i}.${ext || 'png'}`
        const { error } = await supabase.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: false })
        if (error) throw new Error(`Screenshot upload failed: ${error.message}`)
        paths.push(path)
      }
      const res = await fetch('/api/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab_key: tabKey, tab_label: tabLabel, title, details, priority, screenshots: paths }),
      })
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'Could not submit') }
      setDone(true)
      onSubmitted?.()
      setTimeout(() => { setOpen(false); reset() }, 1100)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const PRIS: { k: ReqPriority; label: string }[] = [
    { k: 'low', label: 'Low' }, { k: 'med', label: 'Medium' }, { k: 'high', label: 'High' },
  ]

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Request a change"
        style={{
          position: 'fixed', zIndex: 55,
          right: `max(18px, env(safe-area-inset-right, 0px))`,
          bottom: isMobile ? `calc(74px + env(safe-area-inset-bottom, 0px))` : `calc(20px + env(safe-area-inset-bottom, 0px))`,
          display: 'inline-flex', alignItems: 'center', gap: 8,
          background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer',
          fontFamily: 'var(--font-sans)', fontSize: 13.5, fontWeight: 600,
          borderRadius: 30, padding: isMobile ? '13px' : '12px 18px',
          boxShadow: '0 6px 20px rgba(194,65,12,.32)',
        }}>
        <Plus size={17} strokeWidth={2.6} />
        {!isMobile && 'Request'}
      </button>

      {open && (
        <div onClick={e => { if (e.target === e.currentTarget) close() }}
          style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(27,25,23,.34)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{
            width: '100%', maxWidth: 460, background: 'var(--panel)', border: '1px solid var(--line)',
            borderRadius: '16px 16px 0 0', boxShadow: '0 -10px 40px rgba(0,0,0,.16)',
            padding: `18px 18px calc(18px + env(safe-area-inset-bottom, 0px))`,
            maxHeight: '88vh', overflowY: 'auto',
          }} className="dl-req-sheet">
            {done ? (
              <div style={{ textAlign: 'center', padding: '28px 10px' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--green)' }}>Request sent ✓</div>
                <div style={{ fontSize: 12.5, color: 'var(--text2)', marginTop: 5 }}>Thanks — it's in the owner's list.</div>
              </div>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--text)' }}>New request</h3>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text2)' }}>
                      For <b style={{ color: 'var(--accent)', fontWeight: 600 }}>{tabLabel}</b> · captured automatically
                    </p>
                  </div>
                  <button onClick={close} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text3)', padding: 4 }}><X size={18} /></button>
                </div>

                <div style={{ marginTop: 15 }}>
                  <label htmlFor="req-title" style={lbl}>What would you like changed?</label>
                  <input id="req-title" value={title} onChange={e => setTitle(e.target.value)} autoFocus
                    placeholder="e.g. Add a date filter to the export" style={inp} />
                </div>

                <div style={{ marginTop: 13 }}>
                  <label htmlFor="req-details" style={lbl}>Details (optional)</label>
                  <textarea id="req-details" value={details} onChange={e => setDetails(e.target.value)} rows={3}
                    placeholder="Any context — why, who it helps, an example" style={{ ...inp, resize: 'vertical' as const }} />
                </div>

                <div style={{ marginTop: 13 }}>
                  <label style={lbl}>Priority</label>
                  <div style={{ display: 'flex', gap: 7 }}>
                    {PRIS.map(p => {
                      const on = priority === p.k
                      const col = p.k === 'high' ? 'var(--red)' : p.k === 'med' ? 'var(--amber)' : 'var(--text2)'
                      const bg = p.k === 'high' ? 'var(--red-soft)' : p.k === 'med' ? 'var(--amber-soft)' : 'var(--line-2)'
                      return (
                        <button key={p.k} onClick={() => setPriority(p.k)} style={{
                          flex: 1, cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12, fontWeight: 600,
                          borderRadius: 8, padding: 8,
                          border: `1px solid ${on ? col : 'var(--line)'}`,
                          color: on ? col : 'var(--text2)', background: on ? bg : 'var(--panel-2)',
                        }}>{p.label}</button>
                      )
                    })}
                  </div>
                </div>

                <div style={{ marginTop: 13 }}>
                  <label style={lbl}>Screenshots (optional)</label>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {shots.map((s, i) => (
                      <div key={i} style={{ position: 'relative', width: 60, height: 60, borderRadius: 9, overflow: 'hidden', border: '1px solid var(--line)' }}>
                        <img src={s.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        <button onClick={() => removeShot(i)} aria-label="Remove" style={{
                          position: 'absolute', top: 2, right: 2, width: 18, height: 18, borderRadius: '50%',
                          background: 'rgba(27,25,23,.72)', color: '#fff', border: 'none', cursor: 'pointer',
                          display: 'grid', placeItems: 'center', padding: 0,
                        }}><X size={11} /></button>
                      </div>
                    ))}
                    {shots.length < MAX_SHOTS && (
                      <button onClick={() => fileRef.current?.click()} style={{
                        width: 60, height: 60, borderRadius: 9, border: '1px dashed var(--border2)', background: 'var(--panel-2)',
                        cursor: 'pointer', display: 'grid', placeItems: 'center', color: 'var(--text3)',
                      }} aria-label="Add screenshot"><ImagePlus size={18} /></button>
                    )}
                  </div>
                  <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={e => addFiles(e.target.files)} />
                </div>

                {err && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)', background: 'var(--red-soft)', padding: '8px 10px', borderRadius: 8 }}>{err}</div>}

                <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
                  <button onClick={close} disabled={busy} style={{ ...btn, background: 'var(--panel-2)', color: 'var(--text2)', border: '1px solid var(--line)' }}>Cancel</button>
                  <button onClick={submit} disabled={busy || !title.trim()} style={{ ...btn, background: 'var(--accent)', color: '#fff', opacity: busy || !title.trim() ? 0.6 : 1 }}>
                    {busy ? 'Sending…' : 'Submit request'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <style>{`@media (min-width:560px){.dl-req-sheet{border-radius:16px!important;margin:auto}}`}</style>
    </>
  )
}

const lbl: React.CSSProperties = { display: 'block', fontSize: 11.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text3)', marginBottom: 5 }
const inp: React.CSSProperties = { width: '100%', fontFamily: 'var(--font-sans)', fontSize: 13.5, color: 'var(--text)', background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 9, padding: '9px 11px', boxSizing: 'border-box' }
const btn: React.CSSProperties = { flex: 1, border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, borderRadius: 9, padding: 11 }
