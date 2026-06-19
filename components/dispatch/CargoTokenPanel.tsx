'use client'
import { useState, useEffect, useCallback } from 'react'
import { Key, CheckCircle, AlertTriangle, RefreshCw, ChevronDown, ChevronUp, Clock } from 'lucide-react'

interface Meta {
  hasToken: boolean
  source: string
  expiresAt: string | null
  setAt: string | null
  updatedBy: string | null
}

const card = { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }

export default function CargoTokenPanel() {
  const [meta, setMeta] = useState<Meta | null>(null)
  const [token, setToken] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const loadMeta = useCallback(async () => {
    try { const r = await fetch('/api/cargo-token'); if (r.ok) setMeta(await r.json()) } catch { /* ignore */ }
  }, [])
  useEffect(() => { loadMeta() }, [loadMeta])

  const save = async () => {
    if (!token.trim()) return
    setSaving(true); setSaveMsg(null); setTestResult(null)
    try {
      const r = await fetch('/api/cargo-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: token.trim() }) })
      const d = await r.json()
      if (r.ok) { setSaveMsg('Saved.'); setToken(''); await loadMeta() }
      else setSaveMsg(d.error || 'Save failed')
    } catch (e) { setSaveMsg(String(e)) }
    setSaving(false)
  }

  const test = async () => {
    setTesting(true); setTestResult(null)
    try {
      const r = await fetch('/api/cargo-token/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(token.trim() ? { token: token.trim() } : {}) })
      setTestResult(await r.json())
    } catch (e) { setTestResult({ ok: false, message: String(e) }) }
    setTesting(false)
  }

  // Expiry computation
  const now = Date.now()
  const expMs = meta?.expiresAt ? new Date(meta.expiresAt).getTime() : null
  const expired = expMs !== null && expMs < now
  const msLeft = expMs !== null ? expMs - now : null
  const soon = msLeft !== null && msLeft > 0 && msLeft < 3 * 3600000
  const fmtLeft = (ms: number) => {
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000)
    return h > 0 ? `${h}h ${m}m` : `${m}m`
  }

  const status = !meta?.hasToken ? { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca', icon: <AlertTriangle size={14} />, text: 'No Cargo token set' }
    : expired ? { color: 'var(--critical)', bg: 'var(--critical-bg)', border: '#fecaca', icon: <AlertTriangle size={14} />, text: 'Cargo token EXPIRED — refresh it' }
    : soon ? { color: 'var(--today)', bg: 'var(--today-bg)', border: '#fed7aa', icon: <Clock size={14} />, text: `Cargo token expires in ${fmtLeft(msLeft!)}` }
    : { color: 'var(--dispatched)', bg: 'var(--dispatched-bg)', border: '#bbf7d0', icon: <CheckCircle size={14} />, text: expMs ? `Cargo token active · expires in ${fmtLeft(msLeft!)}` : 'Cargo token active' }

  return (
    <div style={{ ...card, overflow: 'hidden' }}>
      {/* Status bar (always visible) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', background: status.bg, borderBottom: open ? `1px solid ${status.border}` : 'none' }}>
        <Key size={15} style={{ color: status.color }} />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: status.color }}>
          {status.icon} {status.text}
        </span>
        {meta?.source === 'env' && <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>(from env var)</span>}
        <button onClick={() => setOpen(v => !v)} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5, background: 'none', border: 'none', cursor: 'pointer', color: status.color, fontSize: 12, fontWeight: 600 }}>
          {open ? <>Hide <ChevronUp size={14} /></> : <>Refresh token <ChevronDown size={14} /></>}
        </button>
      </div>

      {open && (
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column' as const, gap: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--text3)', margin: 0, lineHeight: 1.5 }}>
            Log into the Shiprocket Cargo portal, clear the OTP, and generate a token from its token panel. Paste it here and Save — no redeploy needed. Use <strong>Test now</strong> to confirm Cargo accepts it.
          </p>
          <textarea
            value={token}
            onChange={e => { setToken(e.target.value); setTestResult(null); setSaveMsg(null) }}
            placeholder="Paste the fresh Cargo JWT (starts with eyJ…)"
            style={{ width: '100%', height: 80, padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 7, color: 'var(--text)', fontFamily: 'DM Mono', fontSize: 11, resize: 'vertical' as const, outline: 'none', lineHeight: 1.5 }}
            onFocus={e => e.target.style.borderColor = 'var(--accent)'}
            onBlur={e => e.target.style.borderColor = 'var(--border)'}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
            <button onClick={save} disabled={saving || !token.trim()} style={{ padding: '8px 18px', borderRadius: 7, border: 'none', background: saving || !token.trim() ? 'var(--bg2)' : 'var(--accent)', color: saving || !token.trim() ? 'var(--text3)' : '#fff', fontSize: 13, fontWeight: 600, cursor: saving || !token.trim() ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckCircle size={14} /> {saving ? 'Saving…' : 'Save Token'}
            </button>
            <button onClick={test} disabled={testing} style={{ padding: '8px 18px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 13, fontWeight: 500, cursor: testing ? 'default' : 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              <RefreshCw size={13} style={{ animation: testing ? 'spin 1s linear infinite' : 'none' }} /> {testing ? 'Testing…' : token.trim() ? 'Test this token' : 'Test saved token'}
            </button>
            {saveMsg && <span style={{ fontSize: 12, color: saveMsg === 'Saved.' ? 'var(--dispatched)' : 'var(--critical)', fontWeight: 500 }}>{saveMsg}</span>}
          </div>
          {testResult && (
            <div style={{ padding: '10px 14px', borderRadius: 7, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, background: testResult.ok ? 'var(--dispatched-bg)' : 'var(--critical-bg)', border: `1px solid ${testResult.ok ? '#bbf7d0' : '#fecaca'}`, color: testResult.ok ? 'var(--dispatched)' : 'var(--critical)' }}>
              {testResult.ok ? <CheckCircle size={15} /> : <AlertTriangle size={15} />} {testResult.message}
            </div>
          )}
          {meta?.setAt && (
            <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'DM Mono' }}>
              Last updated {new Date(meta.setAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{meta.updatedBy ? ` by ${meta.updatedBy}` : ''}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
